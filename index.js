const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');
const fs = require('fs');
const path = require('path');

const app = express();
// URLs de produção (Square Cloud) — fixas, sem .env
const FRONTEND_URL = 'https://hemoalert.squareweb.app';
const BACKEND_URL = 'https://backendhemoalert.squareweb.app';
const WHATS_SERVICE_URL = 'https://whatsservicehemoalert.squareweb.app';
const PROD_ART_URL = `${FRONTEND_URL}/art.jpeg`;

// Square Cloud exige porta 80 (Linux); localmente usa 8001
const PORT = process.env.PORT || (process.platform === 'linux' ? 80 : 8001);

const allowedOrigins = [
  FRONTEND_URL,
  BACKEND_URL,
  WHATS_SERVICE_URL,
  'http://localhost:3000',
  'http://localhost:8000',
  'http://localhost:8001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:8001'
];

app.use(cors({
  origin: (origin, callback) => {
    // Sem origin = chamada servidor-a-servidor (backend Python) → liberado
    if (!origin || allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+\.squareweb\.app$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json({ limit: '15mb' }));

// Health check para monitoramento e hosting Square Cloud
app.get('/', (req, res) => {
  res.json({
    service: '🩸 HemoAlerta WhatsApp Service',
    status: currentStatus,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: currentStatus });
});

let client = null;
let currentQrCode = null;
let currentStatus = 'DISCONNECTED'; // DISCONNECTED, STARTING, QRCODE_READY, CONNECTED, ERROR
let deviceInfo = null;
let lastError = null;

function formatPhoneNumber(phone) {
  if (!phone) return null;
  // Remove tudo que não for dígito
  let cleaned = phone.replace(/\D/g, '');
  // Se for número brasileiro com 10 ou 11 dígitos, adiciona 55 se faltar
  if (cleaned.length === 10 || cleaned.length === 11) {
    cleaned = '55' + cleaned;
  }
  // Remove o 9 adicional se for número com 13 dígitos para compatibilidade de WhatsApp se necessário, ou mantém
  if (!cleaned.endsWith('@c.us')) {
    cleaned = cleaned + '@c.us';
  }
  return cleaned;
}

const SESSION_NAME = 'hemoalerta-whatsapp';
const TOKENS_DIR = path.join(__dirname, 'tokens');
const SESSION_DIR = path.join(TOKENS_DIR, SESSION_NAME);
let isStarting = false; // trava: impede vários Chromium abrindo no mesmo perfil
let browserRef = null;   // Chromium aberto (existe antes do client, durante o QR)

// Remove travas do Chromium deixadas por um processo que morreu (restart/crash)
function clearChromiumLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(SESSION_DIR, f), { force: true }); } catch (e) {}
  }
}

// Sessão inválida (deslogado pelo celular): apaga tokens para gerar QR novo
function clearSessionTokens() {
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
}

async function closeClientSafely() {
  const cli = client;
  const browser = browserRef;
  client = null;
  browserRef = null;
  deviceInfo = null;
  if (cli) {
    try { await cli.close(); } catch (e) {}
  }
  // Garante que o Chromium morre mesmo se o login não terminou (tela de QR)
  if (browser) {
    try { await browser.close(); } catch (e) {}
    try { const proc = browser.process && browser.process(); if (proc) proc.kill('SIGKILL'); } catch (e) {}
  }
}

// Venom 5.3 não reconhece mais a tela de login nova do WhatsApp Web
// (seletor .landing-wrapper mudou) e nunca chama catchQR.
// Então lemos o QR direto do <canvas> da página. Após o scan, o Venom
// detecta o pareamento pelo Store e segue o fluxo normal.
let qrWatcher = null;
function watchQrCanvas(page) {
  if (qrWatcher) clearInterval(qrWatcher);
  qrWatcher = setInterval(async () => {
    if (!page || page.isClosed() || currentStatus === 'CONNECTED') {
      clearInterval(qrWatcher);
      qrWatcher = null;
      return;
    }
    try {
      const qr = await page.evaluate(() => {
        const mode = window?.Store?.Stream?.mode;
        if (mode && mode !== 'QR') return null;
        const canvas = document.querySelector('div[data-ref] canvas') || document.querySelector('canvas');
        if (!canvas || !canvas.width) return null;
        return canvas.toDataURL('image/png');
      });
      if (qr && qr !== currentQrCode) {
        if (!currentQrCode) console.log('[Venom] QR Code capturado da página. Escaneie pelo painel admin ou em /qr');
        currentQrCode = qr;
        currentStatus = 'QRCODE_READY';
      }
    } catch (e) {
      // página navegando/recarregando: tenta de novo no próximo ciclo
    }
  }, 2000);
}

function startVenomSession() {
  if (currentStatus === 'CONNECTED' && client) {
    console.log('[Venom] Sessão já está ativa e conectada.');
    return;
  }
  if (isStarting) {
    console.log('[Venom] Inicialização já em andamento, ignorando nova chamada.');
    return;
  }

  isStarting = true;
  currentStatus = 'STARTING';
  currentQrCode = null;
  lastError = null;
  clearChromiumLocks();
  console.log('[Venom] Iniciando navegador e sessão Venom...');

  venom
    .create({
      session: SESSION_NAME,
      browserInstance: (browser, page) => {
        browserRef = browser;
        watchQrCanvas(page);
      },
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`[Venom] Novo QR Code capturado (tentativa ${attempts}).`);
        currentQrCode = base64Qr;
        currentStatus = 'QRCODE_READY';
      },
      statusFind: (statusSession, session) => {
        console.log(`[Venom] Status da sessão: ${statusSession}`);
        if (
          statusSession === 'isLogged' ||
          statusSession === 'chatsAvailable' ||
          statusSession === 'successChat' ||
          statusSession === 'inChat'
        ) {
          currentStatus = 'CONNECTED';
          currentQrCode = null;
        } else if (
          statusSession === 'notLogged' ||
          statusSession === 'waitForLogin'
        ) {
          currentStatus = currentQrCode ? 'QRCODE_READY' : 'STARTING';
        } else if (statusSession === 'qrReadSuccess') {
          // QR lido pelo celular: WhatsApp Web está sincronizando
          currentStatus = 'STARTING';
          currentQrCode = null;
        } else if (statusSession === 'desconnectedMobile' || statusSession === 'desconnected') {
          // Venom emite isso na própria tela de QR (socket ainda não conectado).
          // Não é logout real: só aguarda o QR Code aparecer.
          if (!currentQrCode) currentStatus = 'STARTING';
        } else if (statusSession === 'noOpenBrowser' || statusSession === 'initBrowserError') {
          currentStatus = 'ERROR';
          lastError = 'Falha ao abrir o navegador Chromium no servidor.';
        } else if (
          statusSession === 'browserClose' ||
          statusSession === 'autocloseCalled' ||
          statusSession === 'serverClose'
        ) {
          currentStatus = 'DISCONNECTED';
          client = null;
        }
      },
      autoClose: 0,
      options: {
        headless: process.platform === 'win32' ? false : 'new',
        devtools: false,
        useChrome: process.platform === 'win32',
        debug: false,
        logQR: false,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--js-flags=--max-old-space-size=256'
        ]
      }
    })
    .then(async (cli) => {
      client = cli;
      isStarting = false;
      currentStatus = 'CONNECTED';
      currentQrCode = null;
      console.log('[Venom] Cliente conectado com sucesso!');

      try {
        const host = await cli.getHostDevice();
        deviceInfo = host;
      } catch (err) {
        deviceInfo = { connected: true };
      }

      cli.onStateChange((state) => {
        console.log('[Venom] Estado alterado:', state);
        if (state === 'CONNECTED') {
          currentStatus = 'CONNECTED';
          currentQrCode = null;
        } else if (state === 'CONFLICT') {
          // Outra aba do WhatsApp Web abriu: retoma o controle
          cli.useHere().catch(() => {});
        } else if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          // Deslogado pelo celular: o próprio Venom gera um QR novo (catchQR)
          currentStatus = 'STARTING';
          currentQrCode = null;
          deviceInfo = null;
        }
      });
    })
    .catch((err) => {
      console.error('[Venom] Erro ao iniciar sessão:', err);
      isStarting = false;
      const errorMsg = (err && err.message) || String(err);

      // Sessão inválida/expirada: limpa tokens para o próximo Conectar gerar QR novo
      if (errorMsg.includes('Not Logged') || errorMsg.includes('QRCode')) {
        console.log('[Venom] Limpando sessão inválida automaticamente...');
        closeClientSafely().finally(clearSessionTokens);
      } else {
        closeClientSafely();
      }

      if (currentStatus !== 'DISCONNECTED') {
        currentStatus = 'ERROR';
        lastError = errorMsg;
      }
    });
}

// ---------------------- ROTAS DA API ----------------------

// Status da conexão
app.get('/status', async (req, res) => {
  let isActuallyConnected = false;
  if (client) {
    try {
      isActuallyConnected = await client.isConnected();
    } catch (e) {
      isActuallyConnected = false;
    }
  }

  res.json({
    status: isActuallyConnected ? 'CONNECTED' : currentStatus,
    hasQrCode: !!currentQrCode,
    deviceInfo: deviceInfo,
    lastError: lastError,
    timestamp: new Date().toISOString()
  });
});

// QR Code para renderização no Frontend
app.get('/qrcode', (req, res) => {
  res.json({
    status: currentStatus,
    qrcode: currentQrCode
  });
});

// Página simples para escanear o QR direto no navegador (atualiza a cada 3s)
app.get('/qr', (req, res) => {
  if (!client && !isStarting && currentStatus !== 'CONNECTED') startVenomSession();
  const body = currentStatus === 'CONNECTED'
    ? '<h2>✅ WhatsApp conectado!</h2>'
    : currentQrCode
      ? `<h2>Escaneie no WhatsApp → Aparelhos conectados</h2><img src="${currentQrCode}" style="width:300px;height:300px">`
      : `<h2>⏳ Gerando QR Code... (${currentStatus})</h2>${lastError ? `<p>${lastError}</p>` : ''}`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>HemoAlerta WhatsApp</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px">${body}
<p><a href="/reset">Resetar sessão e gerar novo QR</a></p></body></html>`);
});

// Iniciar conexão com WhatsApp (dispara geração do QR)
app.post('/connect', (req, res) => {
  if (currentStatus === 'CONNECTED' && client) {
    return res.json({ success: true, message: 'Já conectado ao WhatsApp!' });
  }
  if (isStarting) {
    return res.json({ success: true, message: 'Venom já está iniciando... aguarde o QR Code.' });
  }

  startVenomSession();
  res.json({ success: true, message: 'Inicializando Venom... O QR Code estará disponível em instantes.' });
});

// Desconectar do WhatsApp
app.post('/disconnect', async (req, res) => {
  await closeClientSafely();
  isStarting = false;
  currentStatus = 'DISCONNECTED';
  currentQrCode = null;
  res.json({ success: true, message: 'Sessão do WhatsApp desconectada.' });
});

// Nova conexão do zero: fecha Chromium, apaga token antigo e gera QR novo
// (GET também, para abrir direto no navegador: /reset)
async function resetSession(req, res) {
  console.log('[Venom] Reset solicitado: limpando sessão e gerando novo QR Code...');
  await closeClientSafely();
  isStarting = false;
  currentStatus = 'DISCONNECTED';
  currentQrCode = null;
  lastError = null;
  clearSessionTokens();
  setTimeout(startVenomSession, 1500);
  if (req.method === 'GET') return res.redirect('/qr');
  res.json({ success: true, message: 'Sessão resetada. Novo QR Code em instantes — escaneie pelo painel admin.' });
}
app.post('/reset', resetSession);
app.get('/reset', resetSession);

async function bypassMarkedUnread(cli) {
  try {
    if (cli && cli.page) {
      await cli.page.evaluate(() => {
        if (!window.Store) window.Store = {};

        // 1. Evita erro de markedUnread
        if (!window.Store.ReadSeen) window.Store.ReadSeen = {};
        window.Store.ReadSeen.sendSeen = () => Promise.resolve(true);
        window.Store.ReadSeen.markUnread = () => Promise.resolve(true);
        if (window.WAPI) {
          window.WAPI.sendSeen = () => Promise.resolve(true);
        }

        // 2. Localiza o usuário autenticado atual
        function getMyWid() {
          try {
            if (window.Store?.UserPrefsMeUser?.getMaybeMeUser) return window.Store.UserPrefsMeUser.getMaybeMeUser();
            if (window.__debug?.modulesMap?.WAWebUserPrefsMeUser?.defaultExport?.getMaybeMeUser) {
              return window.__debug.modulesMap.WAWebUserPrefsMeUser.defaultExport.getMaybeMeUser();
            }
            if (window.Store?.Conn?.wid) return window.Store.Conn.wid;
            if (window.Store?.Conn?.me) return window.Store.Conn.me;
            if (window.Store?.Me?.wid) return window.Store.Me.wid;
            const lastWid = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid');
            if (lastWid) {
              const clean = lastWid.replace(/:.*@/, '@').replace(/["']/g, '');
              if (window.Store?.WidFactory?.createWid) {
                return window.Store.WidFactory.createWid(clean);
              }
              return { _serialized: clean, user: clean.split('@')[0] };
            }
            if (window.Store?.Chat?.models?.[0]?.id) {
              return window.Store.Chat.models[0].id;
            }
          } catch (e) {}
          return null;
        }

        if (!window.Store.MaybeMeUser || typeof window.Store.MaybeMeUser.getMaybeMeUser !== 'function') {
          window.Store.MaybeMeUser = {
            getMaybeMeUser: getMyWid
          };
        }

        // 3. Torna WAPI.getHost seguro
        if (window.WAPI) {
          window.WAPI.getHost = async function() {
            return getMyWid() || { user: 'me' };
          };

          // 4. Garante que getNewMessageId nunca falhe ou cause erro de gerate newId
          window.WAPI.getNewMessageId = async function(chatId, check = false) {
            try {
              let chat = window.WAPI.getChat ? await window.WAPI.getChat(chatId) : null;
              if (!chat && window.WAPI.returnChat) {
                chat = await window.WAPI.returnChat(chatId);
              }
              const remoteWid = (window.Store?.WidFactory?.createWid)
                ? window.Store.WidFactory.createWid(chatId)
                : ((chat && chat.id) ? chat.id : chatId);
              const newId = (await window.WAPI.getNewId()).toUpperCase();
              const keyObj = {
                fromMe: true,
                id: newId,
                remote: remoteWid,
                _serialized: `true_${remoteWid._serialized || remoteWid}_${newId}`
              };
              if (window.Store?.MsgKey && typeof window.Store.MsgKey === 'function') {
                try {
                  return new window.Store.MsgKey(keyObj);
                } catch (err) {
                  return keyObj;
                }
              }
              return keyObj;
            } catch (err) {
              const newId = '3EB0' + Math.random().toString(36).substring(2, 15).toUpperCase();
              return {
                fromMe: true,
                id: newId,
                remote: chatId,
                _serialized: `true_${chatId}_${newId}`
              };
            }
          };

          // 5. Garante que sendExist não trave em números novos
          const origSendExist = window.WAPI.sendExist;
          window.WAPI.sendExist = async function(chatId, t = true, n = true) {
            try {
              if (origSendExist) {
                const res = await origSendExist(chatId, t, n);
                if (res && res.status !== 404 && res.id) return res;
              }
            } catch (e) {}
            if (window.WAPI.returnChat) {
              return await window.WAPI.returnChat(chatId, t, n);
            }
            return { id: { _serialized: chatId } };
          };
        }
      });
    }
  } catch (e) {
    console.warn('[Venom] Aviso ao configurar ambiente do navegador:', e.message);
  }
}

const wppScriptPath = path.join(__dirname, 'node_modules', '@wppconnect', 'wa-js', 'dist', 'wppconnect-wa.js');

async function ensureWPP(cli) {
  if (!cli || !cli.page) return false;
  try {
    const ready = await cli.page.evaluate(() => typeof window.WPP !== 'undefined' && window.WPP.isReady);
    if (!ready) {
      console.log('[WPP] Injetando motor atualizado @wppconnect/wa-js no WhatsApp Web...');
      await cli.page.addScriptTag({ path: wppScriptPath });
      await cli.page.waitForFunction(() => typeof window.WPP !== 'undefined' && window.WPP.isReady, { timeout: 15000 });
      console.log('[WPP] Motor WhatsApp Web pronto e sincronizado!');
    }
    return true;
  } catch (err) {
    console.warn('[WPP] Aviso ao carregar WPP:', err.message);
    return false;
  }
}

// Função auxiliar para envio seguro e garantido (com suporte opcional a imagem/arte com legenda)
async function sendMessageReliably(targetJid, text, imagePath = null, sendArt = true) {
  let imageBase64Url = null;
  const localArt = path.join(__dirname, 'art.jpeg');
  let targetImage = null;
  if (sendArt) {
    if (imagePath && (imagePath.startsWith('data:') || fs.existsSync(imagePath))) {
      targetImage = imagePath;
    } else if (fs.existsSync(localArt)) {
      // Arte oficial local: evita baixar a mesma imagem a cada mensagem
      targetImage = localArt;
    } else if (imagePath && /^https?:\/\//.test(imagePath)) {
      targetImage = imagePath;
    } else {
      targetImage = PROD_ART_URL;
    }
  }

  if (targetImage) {
    if (targetImage.startsWith('data:')) {
      imageBase64Url = targetImage;
    } else if (targetImage.startsWith('http://') || targetImage.startsWith('https://')) {
      try {
        const resp = await fetch(targetImage);
        if (resp.ok) {
          const arrBuffer = await resp.arrayBuffer();
          const buf = Buffer.from(arrBuffer);
          const mime = targetImage.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
          imageBase64Url = `data:${mime};base64,${buf.toString('base64')}`;
        }
      } catch (eUrl) {
        console.warn('[WPP] Falha ao baixar arte via URL:', eUrl.message);
      }
    } else if (fs.existsSync(targetImage)) {
      try {
        const ext = path.extname(targetImage).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const fileData = fs.readFileSync(targetImage);
        imageBase64Url = `data:${mime};base64,${fileData.toString('base64')}`;
      } catch (eImg) {
        console.warn('[WPP] Aviso ao ler imagem:', eImg.message);
      }
    }
  }

  // 1. Tenta envio com WPPConnect WA-JS (Método 100% compatível com a nova infraestrutura do WhatsApp)
  const wppLoaded = await ensureWPP(client);
  if (wppLoaded) {
    try {
      if (imageBase64Url) {
        console.log(`[WPP] Disparando imagem com legenda para ${targetJid}...`);
        const wppResult = await client.page.evaluate(async ({ to, dataUrl, messageText }) => {
          let destination = to;
          try {
            if (window.WPP?.contact?.queryExists) {
              const exists = await window.WPP.contact.queryExists(to);
              if (exists && exists.wid) {
                destination = exists.wid._serialized || exists.wid;
              }
            }
          } catch (eQuery) {}

          return await window.WPP.chat.sendFileMessage(destination, dataUrl, {
            type: 'image',
            caption: messageText,
            createChat: true,
            waitForAck: true
          });
        }, { to: targetJid, dataUrl: imageBase64Url, messageText: text });

        console.log(`[WPP] Imagem + legenda entregues com sucesso para ${targetJid}!`);
        return wppResult;
      } else {
        console.log(`[WPP] Disparando mensagem de texto para ${targetJid}...`);
        const wppResult = await client.page.evaluate(async ({ to, messageText }) => {
          let destination = to;
          try {
            if (window.WPP?.contact?.queryExists) {
              const exists = await window.WPP.contact.queryExists(to);
              if (exists && exists.wid) {
                destination = exists.wid._serialized || exists.wid;
              }
            }
          } catch (eQuery) {}

          return await window.WPP.chat.sendTextMessage(destination, messageText, {
            createChat: true,
            waitForAck: true
          });
        }, { to: targetJid, messageText: text });

        console.log(`[WPP] Mensagem de texto entregue com sucesso para ${targetJid}!`);
        return wppResult;
      }
    } catch (wppErr) {
      console.warn(`[WPP] Erro no envio via WPP (${wppErr.message}), tentando método de envio alternativo...`);
    }
  }

  // 2. Fallback de envio alternativo
  await bypassMarkedUnread(client);
  if (targetImage && !targetImage.startsWith('data:') && !/^https?:\/\//.test(targetImage) && client.sendImage) {
    try {
      console.log(`[Venom Fallback] Enviando imagem via client.sendImage para ${targetJid}...`);
      return await client.sendImage(targetJid, targetImage, 'art.jpeg', text);
    } catch (eVenomImg) {
      console.warn('[Venom Fallback] Falha em sendImage:', eVenomImg.message);
    }
  }

  const directResult = await client.page.evaluate(async ({ to, messageText }) => {
    let chat = null;
    if (window.WAPI && window.WAPI.getChat) chat = await window.WAPI.getChat(to);
    if (!chat && window.WAPI && window.WAPI.returnChat) chat = await window.WAPI.returnChat(to);
    if (!chat && window.Store?.Chat?.find) {
      const wid = window.Store?.WidFactory?.createWid ? window.Store.WidFactory.createWid(to) : to;
      chat = await window.Store.Chat.find(wid);
    }
    if (!chat) throw new Error(`Não foi possível localizar o chat para ${to}`);

    if (window.Store?.SendTextMsgToChat) {
      const fn = typeof window.Store.SendTextMsgToChat === 'function'
        ? window.Store.SendTextMsgToChat
        : window.Store.SendTextMsgToChat.sendTextMsgToChat;
      if (typeof fn === 'function') {
        return await fn(chat, messageText);
      }
    }
    if (typeof chat.sendMessage === 'function') {
      return await chat.sendMessage(messageText);
    }
    throw new Error('Nenhum método de envio ativo disponível no cliente.');
  }, { to: targetJid, messageText: text });

  return directResult;
}

// Disparar mensagem para um número
app.post('/send', async (req, res) => {
  const { to, message, imagePath, sendArt = true } = req.body;

  if (!client || currentStatus !== 'CONNECTED') {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp do HemoAlerta não está conectado. Conecte pelo QR Code antes de disparar.'
    });
  }

  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Campos "to" e "message" são obrigatórios.' });
  }

  const targetJid = formatPhoneNumber(to);
  if (!targetJid) {
    return res.status(400).json({ success: false, error: 'Número de telefone inválido.' });
  }

  try {
    console.log(`[Venom] Enviando mensagem para ${targetJid}...`);
    const result = await sendMessageReliably(targetJid, message, imagePath, sendArt);
    console.log(`[Venom] Mensagem enviada com sucesso para ${targetJid}!`);
    return res.json({
      success: true,
      message: 'Mensagem enviada com sucesso!',
      result
    });
  } catch (err) {
    console.error(`[Venom] Erro ao enviar mensagem para ${targetJid}:`, err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao enviar mensagem pelo WhatsApp.'
    });
  }
});

// Disparar mensagens em lote (Broadcast para doadores com delay seguro e imagem opcional)
app.post('/broadcast', async (req, res) => {
  const { recipients, message, imagePath, sendArt = true } = req.body;

  if (!client || currentStatus !== 'CONNECTED') {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp do HemoAlerta não está conectado.'
    });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ success: false, error: 'Lista de destinatários vazia.' });
  }

  let sentCount = 0;
  let failCount = 0;
  const errors = [];

  console.log(`[Venom Broadcast] Iniciando disparo para ${recipients.length} doador(es) 1 a 1...`);

  for (let i = 0; i < recipients.length; i++) {
    const donor = recipients[i];
    const phone = donor.whatsapp || donor.telefone || donor.numero;
    const name = donor.nome || donor.nomeCompleto || 'Doador(a)';
    const customMessage = message.split('{nome}').join(name);

    const targetJid = formatPhoneNumber(phone);
    if (!targetJid) {
      failCount++;
      continue;
    }

    try {
      console.log(`[Venom Broadcast] (${i + 1}/${recipients.length}) Enviando para ${name} (${targetJid})...`);
      await sendMessageReliably(targetJid, customMessage, imagePath, sendArt);
      sentCount++;
      // Intervalo seguro entre envios (1,8s) para respeitar anti-spam e garantir envio do socket
      await new Promise((r) => setTimeout(r, 1800));
    } catch (err) {
      failCount++;
      errors.push({ phone, error: err.message });
      console.warn(`[Venom Broadcast] Falha ao enviar para ${targetJid}:`, err.message);
    }
  }

  console.log(`[Venom Broadcast] Finalizado: ${sentCount} enviados, ${failCount} falhas.`);

  res.json({
    success: true,
    total: recipients.length,
    sentCount,
    failCount,
    errors
  });
});

app.listen(PORT, () => {
  console.log(`🩸 [HemoAlerta] Serviço WhatsApp Venom rodando na porta ${PORT} (${WHATS_SERVICE_URL})`);
  // Inicia automaticamente o Venom ao iniciar o servidor para restaurar sessão existente
  startVenomSession();
});
