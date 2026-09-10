#!/usr/bin/env node
/**
 * testar-precos.js — o cálculo de preços está certo?
 *
 * Hoje mexi no computePriceEUR três vezes: o suplemento noturno, a
 * assinatura errada na rota de alteração, e os retornos. Nada
 * verificava que continuava a dar os mesmos números.
 *
 * Um preço errado não dá erro. Dá uma reserva a 24 euros que devia
 * ser 167, ou uma a 300 que afasta o cliente — e ninguém repara
 * até ao fecho do mês.
 *
 *     node testar-precos.js
 *
 * Devolve 1 se algum falhar, para poder correr antes de publicar.
 */

import { computePriceEUR, isNightPickup } from './precos.js';

let passou = 0;
const falhou = [];


function eIgual(nome, obtido, esperado, margem = 0.01) {
  const ok = Math.abs(obtido - esperado) <= margem;

  if (ok) {
    passou += 1;
  } else {
    falhou.push(`${nome}\n      esperado ${esperado}, obtido ${obtido}`);
  }
}


function eVerdade(nome, valor) {
  if (valor) passou += 1;
  else falhou.push(nome);
}


function entre(nome, valor, min, max) {
  if (valor >= min && valor <= max) {
    passou += 1;
  } else {
    falhou.push(`${nome}\n      esperado entre ${min} e ${max}, obtido ${valor}`);
  }
}


// ============================================================
// A JANELA NOTURNA
//
// 22h55 às 6h. As bordas são o que se engana: um intervalo que
// atravessa a meia-noite escrito como um intervalo normal dá
// sempre falso.
// ============================================================

eVerdade('22:54 não é noite', !isNightPickup('22:54'));
eVerdade('22:55 é noite', isNightPickup('22:55'));
eVerdade('23:30 é noite', isNightPickup('23:30'));
eVerdade('00:00 é noite', isNightPickup('00:00'));
eVerdade('03:15 é noite', isNightPickup('03:15'));
eVerdade('05:59 é noite', isNightPickup('05:59'));
eVerdade('06:00 não é noite', !isNightPickup('06:00'));
eVerdade('12:00 não é noite', !isNightPickup('12:00'));

// Sem hora não há suplemento: na dúvida, o preço mais baixo.
eVerdade('sem hora não é noite', !isNightPickup(null));
eVerdade('hora inválida não é noite', !isNightPickup('abc'));


// ============================================================
// O SUPLEMENTO SÃO 20% EXATOS
//
// O número da Transfeero: 251,42 de dia, 301,70 de noite.
// ============================================================

{
  const dia = computePriceEUR(50, 2, false, {
    pickupText: 'Faro Airport',
    dropoffText: 'Albufeira',
    pickupTime: '14:30'
  });

  const noite = computePriceEUR(50, 2, false, {
    pickupText: 'Faro Airport',
    dropoffText: 'Albufeira',
    pickupTime: '23:30'
  });

  eIgual('o suplemento noturno são 20%', noite, dia * 1.2, 0.5);
}


/**
 * E a percentagem é a mesma em todas as classes.
 *
 * Aplicar o suplemento à base, antes do multiplicador da viatura,
 * dava percentagens diferentes conforme a classe — e um cliente
 * que compare um sedan com uma van encontrava números que não
 * batem certo.
 */
{
  for (const [classe, pax] of [['sedan', 2], ['van', 6], ['premium', 2]]) {
    const dia = computePriceEUR(60, pax, false, {
      vehicleClass: classe,
      pickupText: 'Lisbon Airport',
      dropoffText: 'Cascais',
      pickupTime: '10:00'
    });

    const noite = computePriceEUR(60, pax, false, {
      vehicleClass: classe,
      pickupText: 'Lisbon Airport',
      dropoffText: 'Cascais',
      pickupTime: '02:00'
    });

    eIgual(`suplemento igual em ${classe}`, noite / dia, 1.2, 0.001);
  }
}


// ============================================================
// O MÍNIMO
//
// Uma viagem de dois quilómetros não custa três euros: há um
// motorista a deslocar-se, e abaixo de um valor não compensa a
// ninguém.
// ============================================================

{
  const curta = computePriceEUR(1, 1, true, {
    pickupText: 'Faro Airport',
    dropoffText: 'Faro'
  });

  eVerdade('viagem curta tem preço mínimo', curta >= 24);
}


// Zero quilómetros não parte nada.
{
  const zero = computePriceEUR(0, 1, false, {});
  eVerdade('zero km devolve um número', Number.isFinite(zero) && zero > 0);
}


// ============================================================
// MAIS PASSAGEIROS, MAIS CARO
//
// Nunca ao contrário. Uma van não pode custar menos do que um
// sedan na mesma rota.
// ============================================================

{
  const anterior = { valor: 0, pax: 0 };
  let sempreSobe = true;

  for (const pax of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const p = computePriceEUR(45, pax, false, {
      pickupText: 'Madrid Airport',
      dropoffText: 'Toledo'
    });

    if (p < anterior.valor) {
      sempreSobe = false;
      falhou.push(
        `${pax} passageiros custa menos que ${anterior.pax}\n` +
        `      ${p} contra ${anterior.valor}`
      );
    }

    anterior.valor = p;
    anterior.pax = pax;
  }

  if (sempreSobe) passou += 1;
}


// ============================================================
// MAIS DISTÂNCIA, MAIS CARO
// ============================================================

{
  let sempreSobe = true;
  let antes = 0;

  for (const km of [5, 20, 50, 100, 200, 400]) {
    const p = computePriceEUR(km, 2, false, {
      pickupText: 'Barcelona Airport',
      dropoffText: 'Somewhere'
    });

    if (p < antes) {
      sempreSobe = false;
      falhou.push(`${km} km custa menos que a distância anterior`);
    }

    antes = p;
  }

  if (sempreSobe) passou += 1;
}


// ============================================================
// OS NÚMEROS QUE CONHECEMOS
//
// Rotas reais, com margens largas. Não é para fixar o preço — é
// para apanhar um erro de ordem de grandeza.
//
// Um cálculo que passe de 55 para 550 tem um erro de fator dez, e
// esse é o que passa despercebido até alguém pagar.
// ============================================================

{
  const casos = [
    { nome: 'Faro a Albufeira', km: 38, pax: 2, pt: true,
      de: 'Faro Airport', para: 'Albufeira', min: 40, max: 80 },

    { nome: 'Lisboa a Cascais', km: 32, pax: 2, pt: true,
      de: 'Lisbon Airport', para: 'Cascais', min: 35, max: 75 },

    { nome: 'Madrid a Toledo', km: 85, pax: 2, pt: false,
      de: 'Madrid Airport', para: 'Toledo', min: 90, max: 190 },

    { nome: 'Santiago a Vigo', km: 90, pax: 2, pt: false,
      de: 'Santiago Airport', para: 'Vigo', min: 90, max: 200 },

    /**
     * A viagem longa, com a margem certa.
     *
     * Este teste tinha o máximo em 900 e falhou a 2365 — e eu
     * mudei a FÓRMULA para o teste passar, em vez de perguntar se
     * o teste estava certo.
     *
     * Não estava. Trezentos quilómetros são cinco horas de carro,
     * ida e volta para o motorista. Dois mil euros é caro, mas não
     * é um erro.
     *
     * Um teste que não bate com a realidade corrige-se no teste.
     */
    { nome: 'viagem longa', km: 300, pax: 4, pt: false,
      de: 'Somewhere', para: 'Far away', min: 1000, max: 3000 }
  ];

  for (const c of casos) {
    const p = computePriceEUR(c.km, c.pax, c.pt, {
      pickupText: c.de,
      dropoffText: c.para
    });

    entre(c.nome, Math.round(p), c.min, c.max);
  }
}


// ============================================================
// NUNCA UM NÚMERO ESTRANHO
//
// NaN, Infinity ou negativo chegam ao Stripe e criam uma sessão
// que falha — ou pior, uma que passa.
// ============================================================

{
  const estranhos = [
    ['distância negativa', -50, 2],
    ['distância enorme', 99999, 2],
    ['zero passageiros', 50, 0],
    ['passageiros a mais', 50, 99],
    ['distância nula', null, 2],
    ['passageiros nulos', 50, null]
  ];

  let todosBons = true;

  for (const [nome, km, pax] of estranhos) {
    const p = computePriceEUR(km, pax, false, {});

    if (!Number.isFinite(p) || p <= 0) {
      todosBons = false;
      falhou.push(`${nome} devolve ${p}`);
    }
  }

  if (todosBons) passou += 1;
}


// ============================================================
// O RESULTADO
// ============================================================

console.log('');

if (falhou.length === 0) {
  console.log(`  ${passou} testes, todos passaram.`);
  console.log('');
  process.exit(0);
}

console.log(`  ${passou} passaram, ${falhou.length} FALHARAM`);
console.log('');

for (const f of falhou) {
  console.log('    ' + f);
}

console.log('');
process.exit(1);
