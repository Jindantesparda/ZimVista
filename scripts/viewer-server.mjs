import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', 'dist');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3003);

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp'
};

const normalizePath = (urlPath) => {
    const clean = decodeURIComponent((urlPath || '/').split('?')[0]);
    const target = clean === '/' ? '/viewer.html' : clean;
    const resolved = path.resolve(rootDir, `.${target}`);
    return resolved.startsWith(rootDir) ? resolved : null;
};

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store'
    });
    res.end(body);
};

await mkdir(rootDir, { recursive: true });

const server = http.createServer(async (req, res) => {
    const filePath = normalizePath(req.url);
    if (!filePath) {
        send(res, 403, 'Forbidden');
        return;
    }

    const fallbackPath = path.join(rootDir, 'viewer.html');
    const resolvedPath = existsSync(filePath) ? filePath : fallbackPath;

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
        send(res, 404, 'Not found');
        return;
    }

    try {
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        if (ext === '.html') {
            const html = await readFile(resolvedPath, 'utf8');
            send(res, 200, html, mimeType);
            return;
        }

        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'no-store'
        });
        createReadStream(resolvedPath).pipe(res);
    } catch (error) {
        send(res, 500, `Server error: ${error.message}`);
    }
});

server.listen(port, host, () => {
    console.log(`Viewer server running at http://${host}:${port}/viewer.html`);
});
