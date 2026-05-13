// 客服点击统计 API - 按日期写入文件
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3003;
const LOG_DIR = path.join(__dirname, 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 获取当前日期文件名
function getLogFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return path.join(LOG_DIR, `log_${year}_${month}_${day}.txt`);
}

// 获取客户端 IP
function getClientIp(req) {
    return req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
}

// 获取 User-Agent
function getUserAgent(req) {
    return req.headers['user-agent'] || 'unknown';
}

// 记录点击到日期文件
function logClickToFile(data) {
    const logFile = getLogFileName();
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        ip: data.ip,
        ua: data.ua,
        button: data.button,
        page: data.page,
        referrer: data.referrer
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    
    fs.appendFile(logFile, logLine, (err) => {
        if (err) {
            console.error('Failed to write log:', err);
        } else {
            console.log('Click logged to', path.basename(logFile), ':', data.button);
        }
    });
}

// 读取指定日期的日志文件
function readLogFile(dateStr, callback) {
    // dateStr 格式: 2025_04_16
    const logFile = path.join(LOG_DIR, `log_${dateStr}.txt`);
    
    fs.readFile(logFile, 'utf8', (err, data) => {
        if (err) {
            callback(err, null);
            return;
        }
        
        const lines = data.trim().split('\n').filter(line => line);
        const clicks = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        
        callback(null, clicks);
    });
}

// 获取所有日志文件列表
function getLogFiles(callback) {
    fs.readdir(LOG_DIR, (err, files) => {
        if (err) {
            callback(err, null);
            return;
        }
        
        const logFiles = files
            .filter(f => f.startsWith('log_') && f.endsWith('.txt'))
            .sort()
            .reverse();
        
        callback(null, logFiles);
    });
}

// 简单的去重检查（基于 IP + 按钮 + 日期）
const recentClicks = new Map();

function isDuplicate(ip, button) {
    const key = `${ip}_${button}_${new Date().toDateString()}`;
    if (recentClicks.has(key)) {
        return true;
    }
    recentClicks.set(key, Date.now());
    // 清理旧数据（保留最近1小时）
    const oneHourAgo = Date.now() - 3600000;
    for (const [k, v] of recentClicks.entries()) {
        if (v < oneHourAgo) {
            recentClicks.delete(k);
        }
    }
    return false;
}

const server = http.createServer((req, res) => {
    // 设置 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // 记录点击
    if (req.method === 'POST' && req.url === '/track') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ip = getClientIp(req);
                const ua = getUserAgent(req);
                
                // 检查是否重复点击
                if (isDuplicate(ip, data.button)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, duplicate: true }));
                    return;
                }
                
                // 记录点击到日期文件
                logClickToFile({
                    ip,
                    ua,
                    button: data.button,
                    page: data.page,
                    referrer: data.referrer
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }
    
    // 查看指定日期的统计 - 通过 IP 访问
    // URL: /stats/2025_04_16 或 /stats (今天)
    if (req.url.startsWith('/stats')) {
        let dateStr = req.url.replace('/stats', '').replace('/', '');
        
        // 如果没有指定日期，使用今天
        if (!dateStr) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            dateStr = `${year}_${month}_${day}`;
        }
        
        readLogFile(dateStr, (err, clicks) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    date: dateStr, 
                    total: 0, 
                    clicks: [],
                    error: 'No data for this date'
                }));
                return;
            }
            
            // 统计每个按钮的点击次数（去重后）
            const buttonStats = {};
            const uniqueUsers = new Set();
            
            clicks.forEach(click => {
                const key = `${click.ip}_${click.button}`;
                if (!uniqueUsers.has(key)) {
                    uniqueUsers.add(key);
                    buttonStats[click.button] = (buttonStats[click.button] || 0) + 1;
                }
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                date: dateStr,
                total: clicks.length,
                uniqueClicks: uniqueUsers.size,
                buttonStats,
                clicks: clicks
            }));
        });
        return;
    }
    
    // 获取所有日志文件列表
    if (req.url === '/logs') {
        getLogFiles((err, files) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ files }));
        });
        return;
    }
    
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`Click tracking server running on port ${PORT}`);
    console.log(`Log directory: ${LOG_DIR}`);
    console.log(`Stats URL: http://<ip>:${PORT}/stats/2025_04_16`);
});
