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
    // payload: { id, message }
    try {
      // optimistic ack (client already shows the user message)
      socket.emit('message_ack', { id: payload.id });

      // Call Ollama local REST /api/generate
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || 'llama3.2',
          prompt: payload.message,
          stream: false
        })
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error('Ollama error', res.status, txt);
        socket.emit('bot_error', { id: payload.id, error: 'Ollama error' });
        return;
      }

      const data = await res.json();
      // many Ollama responses include `response` field — adjust if your version differs
      const reply = data.response ?? data.choices?.[0]?.text ?? String(data);

      socket.emit('bot_message', { id: `bot-${Date.now()}`, message: String(reply).trim() });
    } catch (err) {
      console.error(err);
      socket.emit('bot_error', { id: payload.id, error: 'Server error' });
    }
  });

  socket.on('disconnect', () => console.log('disconnected', socket.id));
});

server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
