import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
// The config runner has its own JS context; also close Node's outbound paths.
const reject = () => { throw new Error('Offline native UI build: network disabled'); };
net.connect = reject; net.createConnection = reject; tls.connect = reject;
http.request = reject; http.get = reject; https.request = reject; https.get = reject;
globalThis.fetch = async () => { throw new Error('Offline native UI build: missing local input; network disabled'); };
