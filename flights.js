/**
 * flights.js — a hora a que o avião aterrou
 * ---------------------------------------------------------------
 * O relógio da espera começa na aterragem real, não na hora que o
 * cliente escreveu na reserva.
 *
 * Sem isto, um voo com duas horas de atraso queima a hora grátis
 * antes de o passageiro pisar o chão — e o no-show fica correto no
 * sistema e errado na realidade.
 *
 * Usamos a AeroDataBox, que é a mais barata das que servem. O
 * plano gratuito dá 600 unidades por mês; cada consulta de estado
 * custa uma. Com o volume de agora chega, e o passo seguinte custa
 * cinco dólares.
 *
 * COMO CONFIGURAR:
 *
 *   1. aerodatabox.com — subscrever, mesmo que seja o plano free
 *   2. Copiar a chave (vem do RapidAPI ou do portal deles)
 *   3. No Render:
 *        AERODATABOX_KEY=a-chave
 *        AERODATABOX_HOST=aerodatabox.p.rapidapi.com
 *
 * Sem a chave, isto devolve null e o relógio usa a hora marcada —
 * que é o que já fazia. Nada parte.
 * ---------------------------------------------------------------
 */

const KEY = process.env.AERODATABOX_KEY;
const HOST = process.env.AERODATABOX_HOST || 'aerodatabox.p.rapidapi.com';

const ligado = Boolean(KEY);


/**
 * O número do voo, limpo.
 *
 * As pessoas escrevem "TP 1234", "tp1234", "TAP1234" e às vezes o
 * assento por engano. A API quer "TP1234".
 */
function limparNumero(v) {
  if (!v) return null;

  const x = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

  /**
   * O código da companhia pode ter um dígito.
   *
   * A easyJet é U2, a Ryanair é FR, a Wizz é W6. Uma regra de "só
   * letras" deixava metade das low-cost de fora — e são as que mais
   * atrasam, logo as que mais precisam disto.
   *
   * A regra: duas ou três posições de código, onde a primeira é
   * sempre letra, seguidas de um a quatro dígitos de voo.
   */
  return /^[A-Z][A-Z0-9]{1,2}\d{1,4}$/.test(x) ? x : null;
}


/**
 * Quando é que este voo aterrou.
 *
 * Devolve null quando não sabe — e isso é uma resposta legítima:
 * um voo que ainda não aterrou, um número errado, a API em baixo.
 * Quem chama trata o null usando a hora marcada.
 */
export async function flightLanding(flightNumber, date) {
  if (!ligado) return null;

  const numero = limparNumero(flightNumber);
  if (!numero || !date) return null;

  try {
    /**
     * A data serve para desambiguar.
     *
     * O TP1234 voa todos os dias. Sem a data, a API devolve o de
     * hoje — que pode não ser o da reserva.
     */
    const url = `https://${HOST}/flights/number/${numero}/${date}` +
      '?withAircraftImage=false&withLocation=false';

    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': KEY,
        'X-RapidAPI-Host': HOST
      }
    });

    if (!res.ok) {
      // 404 é normal: um voo que não existe nesse dia. Os outros
      // valem um registo.
      if (res.status !== 404) {
        console.error('[flights]', res.status, await res.text().catch(() => ''));
      }
      return null;
    }

    const dados = await res.json();
    const voos = Array.isArray(dados) ? dados : [dados];

    if (!voos.length) return null;

    /**
     * A chegada real, por ordem de confiança.
     *
     *   actual     aterrou, e sabe-se a que horas
     *   estimated  ainda no ar, com previsão atualizada
     *   scheduled  o horário, que é o que já tínhamos
     *
     * O scheduled não interessa: se é só isso, mais vale a hora da
     * reserva, que pelo menos o cliente escolheu.
     */
    const chegada = voos[0]?.arrival;

    if (!chegada) return null;

    const real = chegada.actualTimeUtc || chegada.actualTimeLocal;
    const previsto = chegada.predictedTimeUtc || chegada.predictedTimeLocal;

    const quando = real || previsto;
    if (!quando) return null;

    /**
     * O formato deles tem um espaço antes do fuso: "2026-09-07
     * 14:32Z". O Date do JavaScript não gosta.
     */
    const iso = String(quando).replace(' ', 'T').replace(/Z?$/, 'Z');
    const d = new Date(iso);

    if (isNaN(d.getTime())) return null;

    return {
      landed_at: d.toISOString(),
      // Se é a real ou uma previsão. Importa: uma previsão pode
      // mudar, e cobrar espera com base nela seria injusto.
      confirmed: Boolean(real),
      status: voos[0]?.status || null
    };
  } catch (error) {
    console.error('[flights] lookup failed:', error.message);
    return null;
  }
}


/**
 * Confirmar que a chave funciona.
 *
 * Gasta uma consulta. Vale a pena: descobrir que a chave está
 * errada quando um cliente está à espera é caro.
 */
export async function flightsTest() {
  if (!ligado) {
    return { ok: false, configured: false, missing: ['AERODATABOX_KEY'] };
  }

  // Um voo que existe quase todos os dias, ontem — para haver
  // hora real e não só previsão.
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);

  const r = await flightLanding('TP1234', ontem.toISOString().slice(0, 10));

  return {
    ok: true,
    configured: true,
    sample: r,
    note: r
      ? 'The key works and returned a landing time.'
      : 'The key works but that flight had no data. Try a busier route.'
  };
}
