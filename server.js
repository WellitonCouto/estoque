const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_FSbyD98m_3Pfjnr1TafChbe3UjqaZVruc';
const APP_URL = process.env.APP_URL || 'https://estoque-q5rf.onrender.com';

async function enviarEmailRecuperacao(destinatario, nomeUsuario, token) {
  const link = `${APP_URL}/redefinir-senha?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'JS Contadores <onboarding@resend.dev>',
      to: 'wellitoncoutomidiajs@gmail.com', // plano gratuito Resend: só envia para e-mail verificado
      subject: 'Recuperação de senha — JS Contadores',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin-bottom:8px">Recuperação de senha</h2>
        <p style="color:#555">Olá, <strong>${nomeUsuario}</strong>.</p>
        <p style="color:#555;margin-bottom:24px">Clique no botão abaixo para definir uma nova senha. O link é válido por <strong>1 hora</strong> e pode ser usado apenas uma vez.</p>
        <a href="${link}" style="display:inline-block;background:#2a5bd7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Redefinir minha senha</a>
        <p style="color:#aaa;font-size:12px;margin-top:24px">Se você não solicitou a recuperação, ignore este e-mail.</p>
      </div>`
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error('Erro ao enviar e-mail: ' + (e.message || res.status));
  }
}
const ADM_EMAIL = 'adm.welliton@jscontadores.com.br';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function dynUpdate(obj) {
  const keys = Object.keys(obj);
  return {
    sets: keys.map((k, i) => `${k}=$${i + 1}`).join(','),
    vals: Object.values(obj)
  };
}

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      setor TEXT DEFAULT '',
      is_admin BOOLEAN DEFAULT FALSE,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS itens (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cat TEXT DEFAULT 'Geral',
      unid TEXT DEFAULT 'Unidade',
      qtd INTEGER DEFAULT 0,
      min INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS movimentos (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      item_id INTEGER REFERENCES itens(id) ON DELETE SET NULL,
      item_nome TEXT,
      qtd INTEGER NOT NULL,
      data TEXT,
      resp TEXT,
      obs TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      item_id INTEGER REFERENCES itens(id) ON DELETE SET NULL,
      item_nome TEXT,
      qtd INTEGER DEFAULT 1,
      solicitante TEXT,
      data_pedido TEXT,
      data_entrega TEXT,
      status TEXT DEFAULT 'aberto',
      obs TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS aparelhos (
      id SERIAL PRIMARY KEY,
      sala TEXT NOT NULL,
      departamento TEXT NOT NULL,
      localizacao TEXT DEFAULT '',
      marca TEXT NOT NULL,
      modelo TEXT DEFAULT '',
      potencia TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chamados (
      id SERIAL PRIMARY KEY,
      aparelho_id INTEGER REFERENCES aparelhos(id) ON DELETE SET NULL,
      sala TEXT, departamento TEXT, marca TEXT, modelo TEXT, potencia TEXT,
      tipo TEXT NOT NULL,
      problema TEXT,
      data_chamado TEXT,
      data_conserto TEXT,
      status TEXT DEFAULT 'aberto',
      obs TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS demandas (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descricao TEXT DEFAULT '',
      solicitante TEXT DEFAULT '',
      iniciado_por TEXT DEFAULT '',
      data_solicitacao TEXT,
      precisa_aprovacao BOOLEAN DEFAULT FALSE,
      valor_solicitado NUMERIC(12,2),
      data_sol_orcamento TEXT,
      data_aprov_orcamento TEXT,
      status TEXT DEFAULT 'aberto',
      data_conclusao TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS anotacoes (
      id SERIAL PRIMARY KEY,
      demanda_id INTEGER REFERENCES demandas(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      data TEXT,
      autor TEXT DEFAULT '',
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS anotacoes_chamado (
      id SERIAL PRIMARY KEY,
      chamado_id INTEGER REFERENCES chamados(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      data TEXT,
      autor TEXT DEFAULT '',
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS filtros_agua (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL,
      descricao TEXT DEFAULT '',
      data_troca TEXT NOT NULL,
      meses_validade INTEGER DEFAULT 6
    );
    CREATE TABLE IF NOT EXISTS extintores (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL,
      tipo TEXT DEFAULT '',
      numero_serie TEXT DEFAULT '',
      data_vencimento TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS veiculos (
      id SERIAL PRIMARY KEY,
      placa TEXT NOT NULL,
      ano INTEGER NOT NULL,
      renavam TEXT NOT NULL,
      modelo TEXT DEFAULT '',
      possui_seguro BOOLEAN DEFAULT FALSE,
      seguradora TEXT DEFAULT '',
      vigencia_seguro TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS motoristas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      documento TEXT DEFAULT '',
      vencimento_cnh TEXT,
      telefone TEXT DEFAULT '',
      status TEXT DEFAULT 'ativo',
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  const adm = await pool.query('SELECT id FROM usuarios WHERE email=$1', [ADM_EMAIL]);
  if (!adm.rows.length) {
    await pool.query(
      'INSERT INTO usuarios (nome,email,senha_hash,is_admin) VALUES ($1,$2,$3,TRUE)',
      ['Welliton', ADM_EMAIL, sha('admin123')]
    );
    console.log('Admin criado. Senha padrão: admin123 — troque após o primeiro acesso.');
  }

  // Migrações — adiciona colunas novas sem recriar tabelas existentes
  await pool.query(`ALTER TABLE anotacoes ADD COLUMN IF NOT EXISTS autor TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE anotacoes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT NOW()`);
  await pool.query(`ALTER TABLE demandas ADD COLUMN IF NOT EXISTS iniciado_por TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE demandas ADD COLUMN IF NOT EXISTS urgencia TEXT DEFAULT 'normal'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS anotacoes_chamado (
    id SERIAL PRIMARY KEY,
    chamado_id INTEGER REFERENCES chamados(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    data TEXT,
    autor TEXT DEFAULT '',
    criado_em TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS tokens_recuperacao (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expira_em TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);

  // Frota expandida
  await pool.query(`CREATE TABLE IF NOT EXISTS abastecimentos (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    motorista_id INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
    data TEXT NOT NULL,
    km NUMERIC(10,1),
    litros NUMERIC(10,3),
    valor NUMERIC(12,2),
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS manutencoes (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    data TEXT NOT NULL,
    km NUMERIC(10,1),
    tipo TEXT NOT NULL,
    descricao TEXT NOT NULL,
    valor NUMERIC(12,2),
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS licenciamentos (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    ano INTEGER NOT NULL,
    data_pagamento TEXT,
    valor NUMERIC(12,2),
    status TEXT DEFAULT 'pendente',
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS registros_km (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    data TEXT,
    km_atual NUMERIC(10,1) NOT NULL,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS custos (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    data TEXT,
    tipo TEXT NOT NULL,
    descricao TEXT DEFAULT '',
    valor NUMERIC(12,2),
    origem TEXT DEFAULT 'manual',
    origem_id INTEGER,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS alertas_config (
    id SERIAL PRIMARY KEY,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE CASCADE,
    tipo_alerta TEXT NOT NULL,
    intervalo_km NUMERIC(10,1),
    intervalo_dias INTEGER,
    antecedencia_dias INTEGER NOT NULL DEFAULT 30,
    km_referencia NUMERIC(10,1),
    data_referencia TEXT,
    criado_em TIMESTAMP DEFAULT NOW(),
    UNIQUE(veiculo_id, tipo_alerta)
  )`);
  await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS km_referencia NUMERIC(10,1)`);
  await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS data_referencia TEXT`);

  console.log('Banco pronto.');
}

function ok(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function err(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: msg }));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pth = req.url.split('?')[0];

  if (pth.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const b = body ? JSON.parse(body) : {};

        // ── AUTH ──────────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/login') {
          const r = await pool.query('SELECT * FROM usuarios WHERE email=$1 AND senha_hash=$2', [b.email, sha(b.senha)]);
          if (!r.rows.length) return err(res, 401, 'E-mail ou senha incorretos');
          const u = r.rows[0];
          return ok(res, { id: u.id, nome: u.nome, email: u.email, setor: u.setor, is_admin: u.is_admin });
        }


        // ── RECUPERAÇÃO DE SENHA (solicitar) ──────────────────
        if (req.method === 'POST' && pth === '/api/recuperar-senha') {
          const { email } = b;
          if (!email) return err(res, 400, 'Informe o e-mail');
          const r = await pool.query('SELECT id, nome FROM usuarios WHERE email=$1', [email]);
          if (r.rows.length) {
            const usuario = r.rows[0];
            const token = crypto.randomBytes(32).toString('hex');
            const expira = new Date(Date.now() + 60 * 60 * 1000);
            await pool.query(
              'INSERT INTO tokens_recuperacao (usuario_id, token, expira_em) VALUES ($1, $2, $3)',
              [usuario.id, token, expira]
            );
            await enviarEmailRecuperacao(email, usuario.nome, token);
          }
          return ok(res, { ok: true });
        }

        // ── RECUPERAÇÃO DE SENHA (redefinir com token) ────────
        if (req.method === 'POST' && pth === '/api/redefinir-senha') {
          const { token, nova_senha } = b;
          if (!token || !nova_senha) return err(res, 400, 'Token e nova senha são obrigatórios');
          if (nova_senha.length < 6) return err(res, 400, 'A senha deve ter pelo menos 6 caracteres');
          const r = await pool.query(
            'SELECT * FROM tokens_recuperacao WHERE token=$1 AND usado=FALSE AND expira_em > NOW()',
            [token]
          );
          if (!r.rows.length) return err(res, 400, 'Link inválido ou expirado. Solicite um novo.');
          const tk = r.rows[0];
          await pool.query('UPDATE usuarios SET senha_hash=$1 WHERE id=$2', [sha(nova_senha), tk.usuario_id]);
          await pool.query('UPDATE tokens_recuperacao SET usado=TRUE WHERE id=$1', [tk.id]);
          return ok(res, { ok: true });
        }

        // ── TROCA DE SENHA (requer login) ─────────────────────
        if (req.method === 'POST' && pth === '/api/trocar-senha') {
          const userId = parseInt(req.headers['x-user-id']);
          if (!userId) return err(res, 401, 'Não autenticado');
          if (!b.senha_atual || !b.nova_senha) return err(res, 400, 'Informe a senha atual e a nova senha');
          const r = await pool.query('SELECT senha_hash FROM usuarios WHERE id=$1', [userId]);
          if (!r.rows.length || r.rows[0].senha_hash !== sha(b.senha_atual))
            return err(res, 403, 'Senha atual incorreta');
          await pool.query('UPDATE usuarios SET senha_hash=$1 WHERE id=$2', [sha(b.nova_senha), userId]);
          return ok(res, { ok: true });
        }

        // ── GUARD: todas as rotas abaixo exigem usuário autenticado ──
        const authId = parseInt(req.headers['x-user-id']);
        const authAdmin = req.headers['x-user-admin'] === 'true';
        if (!authId) return err(res, 401, 'Não autenticado');

        // ── USUÁRIOS ──────────────────────────────────────────
        if (req.method === 'GET' && pth === '/api/usuarios') {
          if (!authAdmin) return err(res, 403, 'Acesso restrito ao administrador');
          const r = await pool.query('SELECT id,nome,email,setor,is_admin FROM usuarios ORDER BY nome');
          return ok(res, r.rows);
        }
        if (req.method === 'POST' && pth === '/api/usuarios') {
          if (!authAdmin) return err(res, 403, 'Acesso restrito ao administrador');
          const r = await pool.query(
            'INSERT INTO usuarios (nome,email,senha_hash,setor) VALUES ($1,$2,$3,$4) RETURNING id,nome,email,setor,is_admin',
            [b.nome, b.email, sha(b.senha), b.setor || '']
          );
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/usuarios/')) {
          if (!authAdmin) return err(res, 403, 'Acesso restrito ao administrador');
          const id = parseInt(pth.split('/')[3]);
          if (b.senha) await pool.query('UPDATE usuarios SET nome=$1,setor=$2,senha_hash=$3 WHERE id=$4', [b.nome, b.setor || '', sha(b.senha), id]);
          else await pool.query('UPDATE usuarios SET nome=$1,setor=$2 WHERE id=$3', [b.nome, b.setor || '', id]);
          return ok(res, { ok: true });
        }        if (req.method === 'DELETE' && pth.startsWith('/api/usuarios/')) {
          if (!authAdmin) return err(res, 403, 'Acesso restrito ao administrador');
          const id = parseInt(pth.split('/')[3]);
          const u = await pool.query('SELECT email FROM usuarios WHERE id=$1', [id]);
          if (u.rows[0]?.email === ADM_EMAIL) return err(res, 403, 'Não é possível remover o administrador');
          await pool.query('DELETE FROM usuarios WHERE id=$1', [id]);
          return ok(res, { ok: true });
        }

        // ── DADOS GERAIS ──────────────────────────────────────
        if (req.method === 'GET' && pth === '/api/dados') {
          const [itens, movs, pedidos, usuarios] = await Promise.all([
            pool.query('SELECT * FROM itens ORDER BY nome'),
            pool.query('SELECT * FROM movimentos ORDER BY criado_em DESC'),
            pool.query('SELECT * FROM pedidos ORDER BY criado_em ASC'),
            pool.query('SELECT id,nome,email,setor,is_admin FROM usuarios ORDER BY nome'),
          ]);
          return ok(res, { itens: itens.rows, movimentos: movs.rows, pedidos: pedidos.rows, usuarios: usuarios.rows });
        }

        // ── ITENS ─────────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/itens') {
          const r = await pool.query('INSERT INTO itens (nome,cat,unid,qtd,min) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.nome, b.cat || 'Geral', b.unid || 'Unidade', b.qtd || 0, b.min || 0]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/itens/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE itens SET nome=$1,cat=$2,unid=$3,qtd=$4,min=$5 WHERE id=$6 RETURNING *', [b.nome, b.cat, b.unid, b.qtd, b.min, id]);
          if (!r.rows.length) return err(res, 404, 'Item não encontrado');
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/itens/')) {
          await pool.query('DELETE FROM itens WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── MOVIMENTOS ────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/movimentos') {
          const item = (await pool.query('SELECT * FROM itens WHERE id=$1', [b.itemId])).rows[0];
          if (!item) return err(res, 404, 'Item não encontrado');
          if ((b.tipo === 'saida' || b.tipo === 'sa') && b.qtd > item.qtd) return err(res, 400, 'Quantidade insuficiente em estoque');
          const novaQtd = (b.tipo === 'entrada' || b.tipo === 'en') ? item.qtd + b.qtd : item.qtd - b.qtd;
          await pool.query('UPDATE itens SET qtd=$1 WHERE id=$2', [novaQtd, b.itemId]);
          const mov = await pool.query('INSERT INTO movimentos (tipo,item_id,item_nome,qtd,data,resp,obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.tipo, b.itemId, item.nome, b.qtd, b.data, b.resp || '—', b.obs || '']);
          return ok(res, { mov: mov.rows[0] }, 201);
        }
        if (req.method === 'POST' && pth === '/api/movimentos/import') {
          const item = (await pool.query('SELECT * FROM itens WHERE id=$1', [b.itemId])).rows[0];
          if (!item) return err(res, 404, 'Item não encontrado');
          const mov = await pool.query('INSERT INTO movimentos (tipo,item_id,item_nome,qtd,data,resp,obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.tipo, b.itemId, item.nome, b.qtd, b.data, b.resp || '—', b.obs || '']);
          return ok(res, mov.rows[0], 201);
        }

        // ── ENTREGA ATÔMICA DE PEDIDO ─────────────────────────
        if (req.method === 'POST' && /^\/api\/pedidos\/\d+\/entregar$/.test(pth)) {
          const pedId = parseInt(pth.split('/')[3]);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const pedRes = await client.query(
              'SELECT * FROM pedidos WHERE id=$1 FOR UPDATE', [pedId]
            );
            const ped = pedRes.rows[0];
            if (!ped) { await client.query('ROLLBACK'); client.release(); return err(res, 404, 'Pedido não encontrado'); }
            if (ped.status === 'entregue') { await client.query('ROLLBACK'); client.release(); return err(res, 409, 'Pedido já foi entregue'); }
            const itemRes = await client.query(
              'SELECT * FROM itens WHERE id=$1 FOR UPDATE', [ped.item_id]
            );
            const item = itemRes.rows[0];
            if (!item) { await client.query('ROLLBACK'); client.release(); return err(res, 404, 'Item não encontrado'); }
            if (item.qtd < ped.qtd) { await client.query('ROLLBACK'); client.release(); return err(res, 400, `Estoque insuficiente: disponível ${item.qtd}, necessário ${ped.qtd}`); }
            const dt = b.data || new Date().toISOString().split('T')[0];
            const resp = b.resp || '—';
            const obs = [`Entrega do pedido #${ped.id} — ${ped.solicitante}`, ped.obs].filter(Boolean).join(' | ');
            await client.query('UPDATE itens SET qtd=$1 WHERE id=$2', [item.qtd - ped.qtd, item.id]);
            await client.query(
              'INSERT INTO movimentos (tipo,item_id,item_nome,qtd,data,resp,obs) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              ['sa', item.id, item.nome, ped.qtd, dt, resp, obs]
            );
            await client.query(
              'UPDATE pedidos SET status=$1,data_entrega=$2 WHERE id=$3',
              ['entregue', dt, pedId]
            );
            await client.query('COMMIT');
            client.release();
            return ok(res, { ok: true, pedido_id: pedId, item: item.nome, qtd: ped.qtd, data: dt });
          } catch (e) {
            await client.query('ROLLBACK');
            client.release();
            throw e;
          }
        }

        // ── PEDIDOS ───────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/pedidos') {
          const r = await pool.query('INSERT INTO pedidos (item_id,item_nome,qtd,solicitante,data_pedido,obs,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.item_id || null, b.item_nome || '', b.qtd || 1, b.solicitante || '', b.data_pedido, b.obs || '', b.status || 'aberto']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/pedidos/')) {
          const id = parseInt(pth.split('/')[3]);
          const { sets, vals } = dynUpdate(b);
          const r = await pool.query(`UPDATE pedidos SET ${sets} WHERE id=$${vals.length + 1} RETURNING *`, [...vals, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/pedidos/')) {
          await pool.query('DELETE FROM pedidos WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── CLIMA ─────────────────────────────────────────────
        if (req.method === 'GET' && pth === '/api/clima') {
          const [ap, ch] = await Promise.all([pool.query('SELECT * FROM aparelhos ORDER BY sala'), pool.query('SELECT * FROM chamados ORDER BY criado_em DESC')]);
          return ok(res, { aparelhos: ap.rows, chamados: ch.rows });
        }
        if (req.method === 'POST' && pth === '/api/aparelhos') {
          const r = await pool.query('INSERT INTO aparelhos (sala,departamento,localizacao,marca,modelo,potencia) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.sala, b.departamento, b.localizacao || '', b.marca, b.modelo || '', b.potencia]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/aparelhos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE aparelhos SET sala=$1,departamento=$2,localizacao=$3,marca=$4,modelo=$5,potencia=$6 WHERE id=$7 RETURNING *', [b.sala, b.departamento, b.localizacao || '', b.marca, b.modelo || '', b.potencia, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/aparelhos/')) {
          await pool.query('DELETE FROM aparelhos WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }
        if (req.method === 'POST' && pth === '/api/chamados') {
          const r = await pool.query('INSERT INTO chamados (aparelho_id,tipo,problema,data_chamado,data_conserto,obs,sala,departamento,marca,modelo,potencia,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [b.aparelho_id || null, b.tipo, b.problema, b.data_chamado, b.data_conserto || null, b.obs || '', b.sala || '', b.departamento || '', b.marca || '', b.modelo || '', b.potencia || '', b.status || 'aberto']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/chamados/')) {
          const id = parseInt(pth.split('/')[3]);
          const { sets, vals } = dynUpdate(b);
          const r = await pool.query(`UPDATE chamados SET ${sets} WHERE id=$${vals.length + 1} RETURNING *`, [...vals, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/chamados/')) {
          await pool.query('DELETE FROM chamados WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        if (req.method === 'GET' && pth === '/api/admin') {
          const [dem, anot, filt, ext, anotch] = await Promise.all([
            pool.query('SELECT * FROM demandas ORDER BY criado_em DESC'),
            pool.query('SELECT * FROM anotacoes ORDER BY criado_em ASC'),
            pool.query('SELECT * FROM filtros_agua ORDER BY data_troca ASC'),
            pool.query('SELECT * FROM extintores ORDER BY data_vencimento ASC'),
            pool.query('SELECT * FROM anotacoes_chamado ORDER BY criado_em ASC'),
          ]);
          return ok(res, { demandas: dem.rows, anotacoes: anot.rows, filtros: filt.rows, extintores: ext.rows, anotacoes_chamado: anotch.rows });
        }

        // ── DEMANDAS ──────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/demandas') {
          const r = await pool.query('INSERT INTO demandas (titulo,descricao,solicitante,iniciado_por,urgencia,data_solicitacao,precisa_aprovacao,valor_solicitado,data_sol_orcamento,data_aprov_orcamento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [b.titulo, b.descricao || '', b.solicitante || '', b.iniciado_por || '', b.urgencia || 'normal', b.data_solicitacao, b.precisa_aprovacao || false, b.valor_solicitado || null, b.data_sol_orcamento || null, b.data_aprov_orcamento || null]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/demandas/')) {
          const id = parseInt(pth.split('/')[3]);
          const { sets, vals } = dynUpdate(b);
          const r = await pool.query(`UPDATE demandas SET ${sets} WHERE id=$${vals.length + 1} RETURNING *`, [...vals, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/demandas/')) {
          await pool.query('DELETE FROM demandas WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── ANOTAÇÕES DEMANDA ─────────────────────────────────
        if (req.method === 'POST' && pth === '/api/anotacoes') {
          const r = await pool.query('INSERT INTO anotacoes (demanda_id,texto,data,autor) VALUES ($1,$2,$3,$4) RETURNING *', [b.demanda_id, b.texto, b.data, b.autor || '']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/anotacoes/')) {
          await pool.query('DELETE FROM anotacoes WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── ANOTAÇÕES CHAMADO ─────────────────────────────────
        if (req.method === 'POST' && pth === '/api/anotacoes-chamado') {
          const r = await pool.query('INSERT INTO anotacoes_chamado (chamado_id,texto,data,autor) VALUES ($1,$2,$3,$4) RETURNING *', [b.chamado_id, b.texto, b.data, b.autor || '']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/anotacoes-chamado/')) {
          await pool.query('DELETE FROM anotacoes_chamado WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── FILTROS ÁGUA ──────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/filtros') {
          const r = await pool.query('INSERT INTO filtros_agua (local,descricao,data_troca,meses_validade) VALUES ($1,$2,$3,$4) RETURNING *', [b.local, b.descricao || '', b.data_troca, b.meses_validade || 6]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/filtros/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE filtros_agua SET local=$1,descricao=$2,data_troca=$3,meses_validade=$4 WHERE id=$5 RETURNING *', [b.local, b.descricao || '', b.data_troca, b.meses_validade || 6, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/filtros/')) {
          await pool.query('DELETE FROM filtros_agua WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── EXTINTORES ────────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/extintores') {
          const r = await pool.query('INSERT INTO extintores (local,tipo,numero_serie,data_vencimento) VALUES ($1,$2,$3,$4) RETURNING *', [b.local, b.tipo || '', b.numero_serie || '', b.data_vencimento]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/extintores/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE extintores SET local=$1,tipo=$2,numero_serie=$3,data_vencimento=$4 WHERE id=$5 RETURNING *', [b.local, b.tipo || '', b.numero_serie || '', b.data_vencimento, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/extintores/')) {
          await pool.query('DELETE FROM extintores WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }


        // ── FROTA ─────────────────────────────────────────────
        if (req.method === 'GET' && pth === '/api/frota') {
          const [vei, mot, abas, mans, lics, kms, cus, alts] = await Promise.all([
            pool.query('SELECT * FROM veiculos ORDER BY placa'),
            pool.query('SELECT * FROM motoristas ORDER BY nome'),
            pool.query('SELECT * FROM abastecimentos ORDER BY data DESC, criado_em DESC'),
            pool.query('SELECT * FROM manutencoes ORDER BY data DESC, criado_em DESC'),
            pool.query('SELECT * FROM licenciamentos ORDER BY ano DESC, criado_em DESC'),
            pool.query('SELECT * FROM registros_km ORDER BY data DESC, criado_em DESC'),
            pool.query('SELECT * FROM custos ORDER BY data DESC, criado_em DESC'),
            pool.query('SELECT * FROM alertas_config ORDER BY veiculo_id, tipo_alerta'),
          ]);
          return ok(res, { veiculos: vei.rows, motoristas: mot.rows, abastecimentos: abas.rows, manutencoes: mans.rows, licenciamentos: lics.rows, registros_km: kms.rows, custos: cus.rows, alertas_config: alts.rows });
        }
        if (req.method === 'POST' && pth === '/api/veiculos') {
          const r = await pool.query('INSERT INTO veiculos (placa,ano,renavam,modelo,possui_seguro,seguradora,vigencia_seguro) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.placa, b.ano, b.renavam, b.modelo||'', !!b.possui_seguro, b.seguradora||'', b.vigencia_seguro||null]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/veiculos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE veiculos SET placa=$1,ano=$2,renavam=$3,modelo=$4,possui_seguro=$5,seguradora=$6,vigencia_seguro=$7 WHERE id=$8 RETURNING *', [b.placa, b.ano, b.renavam, b.modelo||'', !!b.possui_seguro, b.seguradora||'', b.vigencia_seguro||null, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/veiculos/')) {
          await pool.query('DELETE FROM veiculos WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }
        if (req.method === 'POST' && pth === '/api/motoristas') {
          const r = await pool.query('INSERT INTO motoristas (nome,documento,vencimento_cnh,telefone,status) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.nome, b.documento||'', b.vencimento_cnh||null, b.telefone||'', b.status||'ativo']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/motoristas/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE motoristas SET nome=$1,documento=$2,vencimento_cnh=$3,telefone=$4,status=$5 WHERE id=$6 RETURNING *', [b.nome, b.documento||'', b.vencimento_cnh||null, b.telefone||'', b.status||'ativo', id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/motoristas/')) {
          await pool.query('DELETE FROM motoristas WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── ABASTECIMENTOS ────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/abastecimentos') {
          const r = await pool.query('INSERT INTO abastecimentos (veiculo_id,motorista_id,data,km,litros,valor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [b.veiculo_id, b.motorista_id||null, b.data, b.km||null, b.litros||null, b.valor||null]);
          if (b.valor) {
            const vei = await pool.query('SELECT placa,modelo FROM veiculos WHERE id=$1', [b.veiculo_id]);
            const label = vei.rows[0] ? `${vei.rows[0].placa}${vei.rows[0].modelo?' — '+vei.rows[0].modelo:''}` : '';
            await pool.query('INSERT INTO custos (veiculo_id,data,tipo,descricao,valor,origem,origem_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [b.veiculo_id, b.data, 'combustivel', `Abastecimento — ${label}`, b.valor, 'abastecimento', r.rows[0].id]);
          }
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/abastecimentos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE abastecimentos SET veiculo_id=$1,motorista_id=$2,data=$3,km=$4,litros=$5,valor=$6 WHERE id=$7 RETURNING *',
            [b.veiculo_id, b.motorista_id||null, b.data, b.km||null, b.litros||null, b.valor||null, id]);
          await pool.query("UPDATE custos SET data=$1,valor=$2 WHERE origem='abastecimento' AND origem_id=$3", [b.data, b.valor||null, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/abastecimentos/')) {
          const id = parseInt(pth.split('/')[3]);
          await pool.query("DELETE FROM custos WHERE origem='abastecimento' AND origem_id=$1", [id]);
          await pool.query('DELETE FROM abastecimentos WHERE id=$1', [id]);
          return ok(res, { ok: true });
        }

        // ── MANUTENÇÕES ───────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/manutencoes') {
          const r = await pool.query('INSERT INTO manutencoes (veiculo_id,data,km,tipo,descricao,valor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [b.veiculo_id, b.data, b.km||null, b.tipo, b.descricao, b.valor||null]);
          if (b.valor) {
            const vei = await pool.query('SELECT placa,modelo FROM veiculos WHERE id=$1', [b.veiculo_id]);
            const label = vei.rows[0] ? `${vei.rows[0].placa}${vei.rows[0].modelo?' — '+vei.rows[0].modelo:''}` : '';
            await pool.query('INSERT INTO custos (veiculo_id,data,tipo,descricao,valor,origem,origem_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [b.veiculo_id, b.data, 'manutencao', `${b.tipo} — ${label}: ${b.descricao}`, b.valor, 'manutencao', r.rows[0].id]);
          }
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/manutencoes/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE manutencoes SET veiculo_id=$1,data=$2,km=$3,tipo=$4,descricao=$5,valor=$6 WHERE id=$7 RETURNING *',
            [b.veiculo_id, b.data, b.km||null, b.tipo, b.descricao, b.valor||null, id]);
          await pool.query("UPDATE custos SET data=$1,valor=$2,descricao=$3 WHERE origem='manutencao' AND origem_id=$4",
            [b.data, b.valor||null, `${b.tipo} — ${b.descricao}`, id]);
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/manutencoes/')) {
          const id = parseInt(pth.split('/')[3]);
          await pool.query("DELETE FROM custos WHERE origem='manutencao' AND origem_id=$1", [id]);
          await pool.query('DELETE FROM manutencoes WHERE id=$1', [id]);
          return ok(res, { ok: true });
        }

        // ── LICENCIAMENTOS ────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/licenciamentos') {
          const r = await pool.query('INSERT INTO licenciamentos (veiculo_id,ano,data_pagamento,valor,status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [b.veiculo_id, b.ano, b.data_pagamento||null, b.valor||null, b.status||'pendente']);
          if (b.valor && b.status === 'pago') {
            const vei = await pool.query('SELECT placa,modelo FROM veiculos WHERE id=$1', [b.veiculo_id]);
            const label = vei.rows[0] ? `${vei.rows[0].placa}${vei.rows[0].modelo?' — '+vei.rows[0].modelo:''}` : '';
            await pool.query('INSERT INTO custos (veiculo_id,data,tipo,descricao,valor,origem,origem_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [b.veiculo_id, b.data_pagamento||null, 'licenciamento', `Licenciamento ${b.ano} — ${label}`, b.valor, 'licenciamento', r.rows[0].id]);
          }
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/licenciamentos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE licenciamentos SET veiculo_id=$1,ano=$2,data_pagamento=$3,valor=$4,status=$5 WHERE id=$6 RETURNING *',
            [b.veiculo_id, b.ano, b.data_pagamento||null, b.valor||null, b.status||'pendente', id]);
          await pool.query("DELETE FROM custos WHERE origem='licenciamento' AND origem_id=$1", [id]);
          if (b.valor && b.status === 'pago') {
            const vei = await pool.query('SELECT placa,modelo FROM veiculos WHERE id=$1', [b.veiculo_id]);
            const label = vei.rows[0] ? `${vei.rows[0].placa}${vei.rows[0].modelo?' — '+vei.rows[0].modelo:''}` : '';
            await pool.query('INSERT INTO custos (veiculo_id,data,tipo,descricao,valor,origem,origem_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [b.veiculo_id, b.data_pagamento||null, 'licenciamento', `Licenciamento ${b.ano} — ${label}`, b.valor, 'licenciamento', id]);
          }
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/licenciamentos/')) {
          const id = parseInt(pth.split('/')[3]);
          await pool.query("DELETE FROM custos WHERE origem='licenciamento' AND origem_id=$1", [id]);
          await pool.query('DELETE FROM licenciamentos WHERE id=$1', [id]);
          return ok(res, { ok: true });
        }

        // ── REGISTROS KM ──────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/registros-km') {
          const r = await pool.query('INSERT INTO registros_km (veiculo_id,data,km_atual) VALUES ($1,$2,$3) RETURNING *',
            [b.veiculo_id, b.data||null, b.km_atual]);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/registros-km/')) {
          await pool.query('DELETE FROM registros_km WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        // ── CUSTOS (manual) ───────────────────────────────────
        if (req.method === 'POST' && pth === '/api/custos') {
          const r = await pool.query('INSERT INTO custos (veiculo_id,data,tipo,descricao,valor,origem) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [b.veiculo_id||null, b.data||null, b.tipo, b.descricao||'', b.valor||null, 'manual']);
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/custos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('UPDATE custos SET veiculo_id=$1,data=$2,tipo=$3,descricao=$4,valor=$5 WHERE id=$6 AND origem=$7 RETURNING *',
            [b.veiculo_id||null, b.data||null, b.tipo, b.descricao||'', b.valor||null, id, 'manual']);
          if (!r.rows.length) return err(res, 403, 'Só é possível editar lançamentos manuais');
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/custos/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query('SELECT origem FROM custos WHERE id=$1', [id]);
          if (r.rows[0]?.origem !== 'manual') return err(res, 403, 'Só é possível excluir lançamentos manuais');
          await pool.query('DELETE FROM custos WHERE id=$1', [id]);
          return ok(res, { ok: true });
        }

        // ── ALERTAS CONFIG ────────────────────────────────────
        if (req.method === 'POST' && pth === '/api/alertas-config') {
          const r = await pool.query(
            `INSERT INTO alertas_config (veiculo_id,tipo_alerta,intervalo_km,intervalo_dias,antecedencia_dias,km_referencia,data_referencia)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (veiculo_id,tipo_alerta) DO UPDATE
               SET intervalo_km=$3, intervalo_dias=$4, antecedencia_dias=$5, km_referencia=$6, data_referencia=$7
             RETURNING *`,
            [b.veiculo_id, b.tipo_alerta, b.intervalo_km||null, b.intervalo_dias||null, b.antecedencia_dias||30, b.km_referencia||null, b.data_referencia||null]
          );
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/alertas-config/')) {
          const id = parseInt(pth.split('/')[3]);
          const r = await pool.query(
            'UPDATE alertas_config SET intervalo_km=$1,intervalo_dias=$2,antecedencia_dias=$3,km_referencia=$4,data_referencia=$5 WHERE id=$6 RETURNING *',
            [b.intervalo_km||null, b.intervalo_dias||null, b.antecedencia_dias||30, b.km_referencia||null, b.data_referencia||null, id]
          );
          return ok(res, r.rows[0]);
        }
        if (req.method === 'DELETE' && pth.startsWith('/api/alertas-config/')) {
          await pool.query('DELETE FROM alertas_config WHERE id=$1', [parseInt(pth.split('/')[3])]);
          return ok(res, { ok: true });
        }

        err(res, 404, 'Rota não encontrada');
      } catch (e) {
        console.error(e);
        err(res, 500, 'Erro interno: ' + e.message);
      }
    });
    return;
  }

  // Arquivos estáticos
  let fp = (pth === '/' || pth === '/redefinir-senha') ? '/index.html' : pth;
  fp = path.join(__dirname, 'public', fp);
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

iniciarBanco().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`\n✅ Servidor rodando na porta ${PORT}\n`));
}).catch(e => { console.error('Erro banco:', e.message); process.exit(1); });
