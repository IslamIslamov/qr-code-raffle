const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Загружаем localtunnel только если нужен
let localtunnel = null;
if (process.env.TUNNEL_TYPE === 'localtunnel') {
  try {
    localtunnel = require('localtunnel');
  } catch (e) {
    console.log('⚠️  localtunnel не установлен, используйте cloudflared');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
let publicUrl = null;

// Получаем IP-адрес для доступа с других устройств
function getLocalIP() {
  try {
    // Пробуем получить IP через системную команду
    const ip = execSync("ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo ''", { encoding: 'utf8' }).trim();
    if (ip && ip !== '') {
      return ip;
    }
  } catch (e) {
    // Игнорируем ошибки
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const HOST = process.env.HOST || LOCAL_IP;

app.use(cors());
app.use(express.json());

// Роутинг для страниц
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/results', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Статические файлы (CSS, JS, изображения)
app.use(express.static('public'));

// Инициализация базы данных
const db = new sqlite3.Database('./raffle.db', (err) => {
  if (err) {
    console.error('Ошибка подключения к БД:', err.message);
  } else {
    console.log('Подключено к SQLite базе данных');
    // Создаем таблицу участников
    db.run(`CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER UNIQUE NOT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      name TEXT
    )`, (err) => {
      if (err) {
        console.error('Ошибка создания таблицы:', err.message);
      }
    });
  }
});

// Генерация QR-кода
app.get('/api/qrcode', async (req, res) => {
  try {
    // Определяем публичный URL
    let registrationUrl;
    
    // Приоритет 1: Railway публичный домен из переменной окружения
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      registrationUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/register`;
    }
    // Приоритет 2: Хост из заголовков запроса (Railway всегда передает)
    else if (req.headers.host) {
      const protocol = req.headers['x-forwarded-proto'] || 
                      (req.secure ? 'https' : 'http') || 
                      'https';
      registrationUrl = `${protocol}://${req.headers.host}/register`;
    }
    // Приоритет 3: Туннель в разработке
    else if (publicUrl) {
      registrationUrl = `${publicUrl}/register`;
    }
    // Приоритет 4: Локальный доступ (только для разработки)
    else {
      registrationUrl = `http://${HOST}:${PORT}/register`;
    }
    
    console.log('🔗 Генерирую QR-код для URL:', registrationUrl);
    
    const qrCodeDataURL = await QRCode.toDataURL(registrationUrl);
    res.json({ 
      qrcode: qrCodeDataURL, 
      url: registrationUrl,
      isPublic: !registrationUrl.includes('localhost') && !registrationUrl.includes('127.0.0.1')
    });
  } catch (err) {
    console.error('❌ Ошибка генерации QR-кода:', err);
    res.status(500).json({ error: 'Ошибка генерации QR-кода' });
  }
});

// Регистрация участника
app.post('/api/register', (req, res) => {
  // Получаем текущее количество участников
  db.get('SELECT COUNT(*) as count FROM participants', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка базы данных' });
    }

    const currentCount = row.count;

    if (currentCount >= 60) {
      return res.status(400).json({ error: 'Достигнут лимит участников (60)' });
    }

    const nextNumber = currentCount + 1;
    const name = req.body.name || `Участник ${nextNumber}`;

    db.run(
      'INSERT INTO participants (number, name) VALUES (?, ?)',
      [nextNumber, name],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Номер уже занят' });
          }
          return res.status(500).json({ error: 'Ошибка регистрации' });
        }

        res.json({
          success: true,
          number: nextNumber,
          message: `Вы зарегистрированы под номером ${nextNumber}`
        });
      }
    );
  });
});

// Получить всех участников
app.get('/api/participants', (req, res) => {
  db.all('SELECT * FROM participants ORDER BY number', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка получения участников' });
    }
    res.json(rows);
  });
});

// Получить количество участников
app.get('/api/count', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM participants', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка базы данных' });
    }
    res.json({ count: row.count, max: 60 });
  });
});

// Рандомайзер - выбор победителей
app.post('/api/raffle', (req, res) => {
  const count = parseInt(req.body.count) || 10;

  db.all('SELECT * FROM participants ORDER BY number', (err, participants) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка получения участников' });
    }

    if (participants.length < count) {
      return res.status(400).json({ 
        error: `Недостаточно участников. Зарегистрировано: ${participants.length}, требуется: ${count}` 
      });
    }

    // Перемешиваем массив и выбираем случайных
    const shuffled = [...participants].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, count);

    res.json({
      winners: winners,
      total: participants.length,
      selected: count
    });
  });
});

// Сброс базы данных (для тестирования)
app.post('/api/reset', (req, res) => {
  db.run('DELETE FROM participants', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка сброса' });
    }
    res.json({ success: true, message: 'База данных очищена' });
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n========================================');
  if (NODE_ENV === 'production') {
    console.log(`✅ Сервер запущен в продакшене на порту ${PORT}`);
    console.log(`🌍 Приложение доступно через публичный URL хостинга`);
  } else {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
    console.log(`📱 Доступ с других устройств: http://${HOST}:${PORT}`);
  }
  console.log(`⚙️  Страница результатов: /results`);
  console.log('========================================\n');
  
  // Создаем публичный туннель если включен режим публичного доступа
  // НЕ создаем туннель на продакшене (хостинге) - там уже есть публичный URL
  if ((process.env.PUBLIC === 'true' || process.env.PUBLIC === '1') && NODE_ENV !== 'production') {
    const tunnelType = process.env.TUNNEL_TYPE || 'cloudflared';
    
    // Используем localtunnel если указано
    if (tunnelType === 'localtunnel' && localtunnel) {
      try {
        console.log('🌐 Создание публичного URL через Localtunnel...');
        console.log('   ⚠️  ВНИМАНИЕ: Localtunnel показывает страницу с паролем');
        console.log('   Рекомендуется использовать cloudflared (npm run public)\n');
        
        const tunnel = await localtunnel({ 
          port: PORT,
          subdomain: process.env.TUNNEL_SUBDOMAIN
        });
        
        publicUrl = tunnel.url;
        console.log('\n🎉 ПУБЛИЧНЫЙ URL СОЗДАН!');
        console.log('========================================');
        console.log(`🌍 Публичный URL: ${publicUrl}`);
        console.log(`🔗 Регистрация: ${publicUrl}/register`);
        console.log(`📱 QR-код будет доступен через интернет!`);
        console.log('========================================\n');
        console.log('⚠️  ВАЖНО: Гостям нужно будет ввести пароль');
        console.log('   Пароль = ваш публичный IP (см. https://loca.lt/mytunnelpassword)\n');
        
        tunnel.on('close', () => {
          console.log('⚠️  Туннель закрыт');
          publicUrl = null;
        });
      } catch (err) {
        console.log('⚠️  Не удалось создать публичный URL:', err.message);
        console.log('   Попробуйте: npm run public (использует cloudflared)\n');
      }
      return;
    }
    
    // Используем cloudflared (по умолчанию)
    try {
      console.log('🌐 Создание публичного URL через Cloudflare Tunnel...');
      console.log('   (Это может занять несколько секунд)\n');
      
      // Проверяем наличие cloudflared
      try {
        execSync('which cloudflared', { stdio: 'ignore' });
      } catch (e) {
        console.log('❌ ОШИБКА: cloudflared не установлен!');
        console.log('\n📥 Установите cloudflared:');
        console.log('   brew install cloudflared');
        console.log('\nИли используйте альтернативу:');
        console.log('   npm run public-lt     (localtunnel, но требует пароль)\n');
        return;
      }
      
      // Запускаем cloudflared в фоне
      const cloudflared = spawn('cloudflared', [
        'tunnel',
        '--url', `http://localhost:${PORT}`
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let output = '';
      let urlFound = false;
      
      cloudflared.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        
        // Ищем URL в выводе
        const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
        if (urlMatch && !urlFound) {
          urlFound = true;
          publicUrl = urlMatch[0];
          
          console.log('\n🎉 ПУБЛИЧНЫЙ URL СОЗДАН!');
          console.log('========================================');
          console.log(`🌍 Публичный URL: ${publicUrl}`);
          console.log(`🔗 Регистрация: ${publicUrl}/register`);
          console.log(`📱 QR-код будет доступен через интернет!`);
          console.log('========================================\n');
          console.log('✅ Гости могут сканировать QR-код со своих телефонов');
          console.log('   используя свой мобильный интернет (без Wi-Fi)');
          console.log('   БЕЗ страницы с паролем!\n');
        }
      });
      
      cloudflared.stderr.on('data', (data) => {
        // Игнорируем ошибки, они могут быть нормальными
      });
      
      cloudflared.on('close', (code) => {
        if (code !== 0 && !urlFound) {
          console.log('⚠️  Туннель закрыт');
          publicUrl = null;
        }
      });
      
      // Таймаут на случай если URL не найден
      setTimeout(() => {
        if (!urlFound) {
          console.log('⚠️  Не удалось получить публичный URL из cloudflared');
          console.log('   Проверьте вывод выше или попробуйте запустить вручную:');
          console.log('   cloudflared tunnel --url http://localhost:3000\n');
        }
      }, 10000);
      
    } catch (err) {
      console.log('⚠️  Не удалось создать публичный URL:', err.message);
      console.log('   Используется локальный доступ\n');
    }
  } else {
    if (HOST === 'localhost') {
      console.log('💡 Для публичного доступа через интернет:');
      console.log('   Запустите: PUBLIC=true npm start');
      console.log('   Тогда гости смогут сканировать QR-код');
      console.log('   используя свой мобильный интернет (без Wi-Fi)\n');
    }
  }
});

