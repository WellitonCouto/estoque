const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Cria as tabelas se não existirem
async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS itens (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cat TEXT DEFAULT 'Geral',
      unid TEXT DEFAULT 'Unidade',
      qtd INTEGER DEFAULT 0,
      min INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS responsaveis (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      setor TEXT DEFAULT ''
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
      sala TEXT,
      departamento TEXT,
      marca TEXT,
      modelo TEXT,
      potencia TEXT,
      tipo TEXT NOT NULL,
      problema TEXT,
      data_chamado TEXT,
      data_conserto TEXT,
      status TEXT DEFAULT 'aberto',
      obs TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Banco de dados pronto.');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function erro(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: msg }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = req.url.split('?')[0];

  // --- API ---
  if (pathname.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        // GET /api/dados
        if (req.method === 'GET' && pathname === '/api/dados') {
          const itens = await pool.query('SELECT * FROM itens ORDER BY nome ASC');
          const movs = await pool.query('SELECT * FROM movimentos ORDER BY criado_em DESC');
          const resps = await pool.query('SELECT * FROM responsaveis ORDER BY nome ASC');
          return json(res, 200, { itens: itens.rows, movimentos: movs.rows, responsaveis: resps.rows });
        }

        // POST /api/responsaveis
        if (req.method === 'POST' && pathname === '/api/responsaveis') {
          const { nome, setor } = JSON.parse(body);
          const r = await pool.query(
            'INSERT INTO responsaveis (nome, setor) VALUES ($1,$2) RETURNING *',
            [nome, setor || '']
          );
          return json(res, 201, r.rows[0]);
        }

        // DELETE /api/responsaveis/:id
        if (req.method === 'DELETE' && pathname.startsWith('/api/responsaveis/')) {
          const id = parseInt(pathname.split('/')[3]);
          await pool.query('DELETE FROM responsaveis WHERE id=$1', [id]);
          return json(res, 200, { ok: true });
        }

        // POST /api/itens
        if (req.method === 'POST' && pathname === '/api/itens') {
          const { nome, cat, unid, qtd, min } = JSON.parse(body);
          const r = await pool.query(
            'INSERT INTO itens (nome, cat, unid, qtd, min) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [nome, cat || 'Geral', unid || 'Unidade', qtd || 0, min || 0]
          );
          return json(res, 201, r.rows[0]);
        }

        // PUT /api/itens/:id
        if (req.method === 'PUT' && pathname.startsWith('/api/itens/')) {
          const id = parseInt(pathname.split('/')[3]);
          const { nome, cat, unid, qtd, min } = JSON.parse(body);
          const r = await pool.query(
            'UPDATE itens SET nome=$1, cat=$2, unid=$3, qtd=$4, min=$5 WHERE id=$6 RETURNING *',
            [nome, cat, unid, qtd, min, id]
          );
          if (!r.rows.length) return erro(res, 404, 'Item não encontrado');
          return json(res, 200, r.rows[0]);
        }

        // DELETE /api/itens/:id
        if (req.method === 'DELETE' && pathname.startsWith('/api/itens/')) {
          const id = parseInt(pathname.split('/')[3]);
          await pool.query('DELETE FROM itens WHERE id=$1', [id]);
          return json(res, 200, { ok: true });
        }

        // POST /api/movimentos
        if (req.method === 'POST' && pathname === '/api/movimentos') {
          const { tipo, itemId, qtd, data, obs, resp } = JSON.parse(body);
          const itemR = await pool.query('SELECT * FROM itens WHERE id=$1', [itemId]);
          if (!itemR.rows.length) return erro(res, 404, 'Item não encontrado');
          const item = itemR.rows[0];
          if (tipo === 'saida' && qtd > item.qtd) return erro(res, 400, 'Quantidade insuficiente em estoque');
          const novaQtd = tipo === 'entrada' ? item.qtd + qtd : item.qtd - qtd;
          await pool.query('UPDATE itens SET qtd=$1 WHERE id=$2', [novaQtd, itemId]);
          const mov = await pool.query(
            'INSERT INTO movimentos (tipo, item_id, item_nome, qtd, data, resp, obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [tipo, itemId, item.nome, qtd, data, resp || '—', obs || '']
          );
          return json(res, 201, { mov: mov.rows[0], item: { ...item, qtd: novaQtd } });
        }

        // POST /api/movimentos/import — importa histórico sem alterar estoque
        if (req.method === 'POST' && pathname === '/api/movimentos/import') {
          const { tipo, itemId, qtd, data, obs, resp } = JSON.parse(body);
          const itemR = await pool.query('SELECT * FROM itens WHERE id=$1', [itemId]);
          if (!itemR.rows.length) return erro(res, 404, 'Item não encontrado');
          const item = itemR.rows[0];
          const mov = await pool.query(
            'INSERT INTO movimentos (tipo, item_id, item_nome, qtd, data, resp, obs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [tipo, itemId, item.nome, qtd, data, resp || '—', obs || '']
          );
          return json(res, 201, mov.rows[0]);
        }

        // GET /api/clima
        if (req.method === 'GET' && pathname === '/api/clima') {
          const aparelhos = await pool.query('SELECT * FROM aparelhos ORDER BY sala ASC');
          const chamados = await pool.query('SELECT * FROM chamados ORDER BY criado_em DESC');
          return json(res, 200, { aparelhos: aparelhos.rows, chamados: chamados.rows });
        }

        // POST /api/aparelhos
        if (req.method === 'POST' && pathname === '/api/aparelhos') {
          const { sala, departamento, localizacao, marca, modelo, potencia } = JSON.parse(body);
          const r = await pool.query(
            'INSERT INTO aparelhos (sala,departamento,localizacao,marca,modelo,potencia) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [sala, departamento, localizacao||'', marca, modelo||'', potencia]
          );
          return json(res, 201, r.rows[0]);
        }

        // PUT /api/aparelhos/:id
        if (req.method === 'PUT' && pathname.startsWith('/api/aparelhos/')) {
          const id = parseInt(pathname.split('/')[3]);
          const { sala, departamento, localizacao, marca, modelo, potencia } = JSON.parse(body);
          const r = await pool.query(
            'UPDATE aparelhos SET sala=$1,departamento=$2,localizacao=$3,marca=$4,modelo=$5,potencia=$6 WHERE id=$7 RETURNING *',
            [sala, departamento, localizacao||'', marca, modelo||'', potencia, id]
          );
          if (!r.rows.length) return erro(res, 404, 'Aparelho não encontrado');
          return json(res, 200, r.rows[0]);
        }

        // DELETE /api/aparelhos/:id
        if (req.method === 'DELETE' && pathname.startsWith('/api/aparelhos/')) {
          const id = parseInt(pathname.split('/')[3]);
          await pool.query('DELETE FROM aparelhos WHERE id=$1', [id]);
          return json(res, 200, { ok: true });
        }

        // POST /api/chamados
        if (req.method === 'POST' && pathname === '/api/chamados') {
          const { aparelho_id, tipo, problema, data_chamado, data_conserto, obs, sala, departamento, marca, modelo, potencia, status } = JSON.parse(body);
          const r = await pool.query(
            'INSERT INTO chamados (aparelho_id,tipo,problema,data_chamado,data_conserto,obs,sala,departamento,marca,modelo,potencia,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
            [aparelho_id||null, tipo, problema, data_chamado, data_conserto||null, obs||'', sala||'', departamento||'', marca||'', modelo||'', potencia||'', status||'aberto']
          );
          return json(res, 201, r.rows[0]);
        }

        // PUT /api/chamados/:id
        if (req.method === 'PUT' && pathname.startsWith('/api/chamados/')) {
          const id = parseInt(pathname.split('/')[3]);
          const fields = JSON.parse(body);
          const sets = Object.keys(fields).map((k,i) => `${k}=$${i+1}`).join(',');
          const vals = [...Object.values(fields), id];
          const r = await pool.query(`UPDATE chamados SET ${sets} WHERE id=$${vals.length} RETURNING *`, vals);
          if (!r.rows.length) return erro(res, 404, 'Chamado não encontrado');
          return json(res, 200, r.rows[0]);
        }

        // DELETE /api/chamados/:id
        if (req.method === 'DELETE' && pathname.startsWith('/api/chamados/')) {
          const id = parseInt(pathname.split('/')[3]);
          await pool.query('DELETE FROM chamados WHERE id=$1', [id]);
          return json(res, 200, { ok: true });
        }

        erro(res, 404, 'Rota não encontrada');
      } catch (e) {
        console.error(e);
        erro(res, 500, 'Erro interno: ' + e.message);
      }
    });
    return;
  }

  // --- Arquivos estáticos ---
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

iniciarBanco().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
  });
}).catch(e => {
  console.error('Erro ao conectar ao banco:', e.message);
  process.exit(1);
});
