/**
 * airportlink-api/supabaseclient.js
 * ---------------------------------------------------------------
 * O cliente do Supabase e as funções de identidade, num sítio só.
 *
 * ATENÇÃO — ISTO JÁ NÃO É UM SERVIDOR.
 *
 * A versão anterior deste ficheiro era um segundo servidor Express,
 * com uma cópia antiga da rota /api/confirm-payment. Duas cópias da
 * mesma lógica desatualizam-se sempre: aquela gravava reservas sem
 * price_eur, sem pickup_airport e sem payment_mode — reservas que
 * ficavam invisíveis no painel financeiro e nunca chegavam a um
 * parceiro.
 *
 * Agora é o que o nome sempre prometeu: um módulo partilhado. Não
 * tem app.listen(). Se algum serviço no Render tiver isto como
 * ponto de entrada, esse serviço deixa de arrancar — e a correção é
 * apontá-lo ao server.js ou apagá-lo, porque não faz falta nenhuma.
 * ---------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';

// ============================================================
// CONFIGURAÇÃO
// ============================================================

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is required');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

/**
 * Um aviso barato que poupa uma tarde de diagnóstico.
 *
 * Se aqui estiver a chave pública em vez da secreta, o Postgres
 * trata todos os pedidos como se viessem de um visitante anónimo, e
 * as escritas falham com "permission denied" e uma dica a mandar
 * dar GRANT ao papel anon. Já aconteceu neste projeto.
 */
if (process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_publishable_')) {
  console.error(
    '\n' +
    '  SUPABASE_SERVICE_ROLE_KEY contains the PUBLISHABLE key.\n' +
    '  Every write will fail with "permission denied".\n' +
    '  Copy the secret key from Supabase > Settings > API Keys.\n'
  );
}

export const DEFAULT_AGENT_COMMISSION = Number(process.env.AGENT_COMMISSION || 12);
export const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.airportlink.app';

/**
 * O cliente com service_role: ignora a RLS por completo.
 *
 * É por isso que este ficheiro nunca pode ser servido ao browser, e
 * por isso que todas as rotas que o usam verificam quem está a pedir
 * antes de escreverem seja o que for.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false }
  }
);

// ============================================================
// NÚMEROS VINDOS DE FORA
// ============================================================

/**
 * Um número a partir do que quer que tenha chegado.
 *
 * Os metadados do Stripe são sempre texto, e a vírgula decimal
 * aparece consoante a localização de quem preencheu o formulário.
 * "416,50" tem de virar 416.5 e não 416.
 */
export function cleanNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  const match = String(value).replace(',', '.').match(/-?[\d.]+/);
  if (!match) return null;

  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

export function cleanInt(value) {
  const n = cleanNumber(value);
  return n === null ? null : Math.trunc(n);
}

// ============================================================
// IDENTIDADE
//
// O token é sempre validado no servidor do Supabase. Nunca
// confiamos no que o browser diz que é — e a margem do agente é
// calculada a partir do JWT, senão qualquer pessoa reclamava 12%
// de desconto.
// ============================================================

/** O utilizador por trás do pedido, ou null. */
export async function getUserFromRequest(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!token) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}

/**
 * A agência aprovada por trás do utilizador, ou null.
 *
 * travel_agents é a tabela das AGÊNCIAS. A contacts continua a ser a
 * das pessoas — o agente tem linha nas duas.
 */
export async function getApprovedAgent(user) {
  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from('travel_agents')
    .select('id, email, contact_name, agency_name, status, commission')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !data || data.status !== 'approved') {
    return null;
  }

  const pct = Number(data.commission);

  return {
    ...data,
    commission: Number.isFinite(pct) && pct > 0 && pct < 100
      ? pct
      : DEFAULT_AGENT_COMMISSION
  };
}

/**
 * Devolve { user } ou { error }.
 *
 * A distinção importa: "não estás autenticado" e "esta conta não é
 * administrador" pedem ações diferentes de quem está do outro lado,
 * e no mesmo browser é fácil a sessão ter sido substituída por outra.
 */
export async function requireAdmin(req) {
  const user = await getUserFromRequest(req);

  if (!user) {
    return { error: 'Not signed in. Your session may have expired or been replaced.' };
  }

  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, is_admin')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    return { error: 'Could not verify your account.' };
  }

  if (!data || data.is_admin !== true) {
    return {
      error: `You are signed in as ${user.email}, which is not an administrator account. ` +
             'Sign out and sign in with your admin account.'
    };
  }

  return { user };
}

// ============================================================
// DIAGNÓSTICO
// ============================================================

/**
 * A ligação está boa e a chave é a certa?
 *
 * Uma leitura qualquer chega para saber. Chamado no arranque do
 * server.js: mais vale descobrir agora do que na primeira reserva.
 */
export async function checkConnection() {
  try {
    const { error } = await supabase.from('contacts').select('id').limit(1);

    if (error) {
      console.error('Supabase check failed:', error.message);
      return { ok: false, error: error.message };
    }

    console.log('Supabase connection ok');
    return { ok: true };
  } catch (error) {
    console.error('Supabase check threw:', error.message);
    return { ok: false, error: error.message };
  }
}
