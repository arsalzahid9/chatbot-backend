// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

dotenv.config();
const PORT = process.env.PORT || 5000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.json({ ok: true }));
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        prompt: message,
        stream: false
      })
    });
    if (!ollamaRes.ok) {
      const txt = await ollamaRes.text();
      console.error('Ollama error', ollamaRes.status, txt);
      return res.status(500).json({ error: 'Ollama error', details: txt });
    }
    const data = await ollamaRes.json();
    const reply = data.response ?? data.choices?.[0]?.text ?? String(data);
    res.json({ reply: String(reply).trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000' } });

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('user_message', async (payload) => {
    try {
      socket.emit('message_ack', { id: payload.id });
      const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || 'llama3.2',
          prompt: payload.message,
          stream: true
        })
      });
      if (!ollamaRes.ok || !ollamaRes.body) {
        const txt = await ollamaRes.text();
        console.error('Ollama error', ollamaRes.status, txt);
        socket.emit('bot_error', { id: payload.id, error: 'Ollama error' });
        return;
      }
      let reply = '';
      let buffer = '';
      ollamaRes.body.on('data', (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line for next chunk
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.response) {
              reply += json.response;
              socket.emit('bot_message', { id: `bot-${Date.now()}`, message: reply });
            }
          } catch (e) {
            // ignore parse errors for incomplete lines
          }
        }
      });
      ollamaRes.body.on('end', () => {
        // Optionally emit a final message or completion event
      });
      ollamaRes.body.on('error', (err) => {
        console.error(err);
        socket.emit('bot_error', { id: payload.id, error: 'Stream error' });
      });
    } catch (err) {
      console.error(err);
      socket.emit('bot_error', { id: payload.id, error: 'Server error' });
    }
  });
  socket.on('disconnect', () => console.log('disconnected', socket.id));
});

server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
