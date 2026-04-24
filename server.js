const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
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
  await pool.query(`CREATE TABLE IF NOT EXISTS anotacoes_chamado (
    id SERIAL PRIMARY KEY,
    chamado_id INTEGER REFERENCES chamados(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    data TEXT,
    autor TEXT DEFAULT '',
    criado_em TIMESTAMP DEFAULT NOW()
  )`);

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

        if (req.method === 'POST' && pth === '/api/recuperar-senha') {
          if (b.email !== ADM_EMAIL) return err(res, 403, 'Recuperação disponível somente para o administrador');
          await pool.query('UPDATE usuarios SET senha_hash=$1 WHERE email=$2', [sha(b.nova_senha), ADM_EMAIL]);
          return ok(res, { ok: true });
        }

        // ── USUÁRIOS ──────────────────────────────────────────
        if (req.method === 'GET' && pth === '/api/usuarios') {
          const r = await pool.query('SELECT id,nome,email,setor,is_admin FROM usuarios ORDER BY nome');
          return ok(res, r.rows);
        }
        if (req.method === 'POST' && pth === '/api/usuarios') {
          const r = await pool.query(
            'INSERT INTO usuarios (nome,email,senha_hash,setor) VALUES ($1,$2,$3,$4) RETURNING id,nome,email,setor,is_admin',
            [b.nome, b.email, sha(b.senha), b.setor || '']
          );
          return ok(res, r.rows[0], 201);
        }
        if (req.method === 'PUT' && pth.startsWith('/api/usuarios/')) {
          const id = parseInt(pth.split('/')[3]);
          if (b.senha) await pool.query('UPDATE usuarios SET nome=$1,setor=$2,senha_hash=$3 WHERE id=$4', [b.nome, b.setor || '', sha(b.senha), id]);
          else await pool.query('UPDATE usuarios SET nome=$1,setor=$2 WHERE id=$3', [b.nome, b.setor || '', id]);
          return ok(res, { ok: true });
        }        if (req.method === 'DELETE' && pth.startsWith('/api/usuarios/')) {
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
          const r = await pool.query('INSERT INTO demandas (titulo,descricao,solicitante,iniciado_por,data_solicitacao,precisa_aprovacao,valor_solicitado,data_sol_orcamento,data_aprov_orcamento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [b.titulo, b.descricao || '', b.solicitante || '', b.iniciado_por || '', b.data_solicitacao, b.precisa_aprovacao || false, b.valor_solicitado || null, b.data_sol_orcamento || null, b.data_aprov_orcamento || null]);
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

        err(res, 404, 'Rota não encontrada');
      } catch (e) {
        console.error(e);
        err(res, 500, 'Erro interno: ' + e.message);
      }
    });
    return;
  }

  // Arquivos estáticos
  let fp = pth === '/' ? '/index.html' : pth;
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
