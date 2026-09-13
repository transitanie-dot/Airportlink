#!/usr/bin/env python3
"""
verificar.py — o que devia ter sido feito antes de enviar.

Três erros repetiram-se numa sessão inteira, e todos tinham a mesma
causa: escrever um nome novo sem procurar se já existia.

  followup       quando já havia follow-up
  pintarVistas   quando já havia uma função com esse nome
  close_chat     quando já havia uma rota e um botão assim

Mais uma família inteira de colunas inventadas: vehicle_class,
return_of, stage, responded_at, sender_id, calendar_event_id.

Este ficheiro corre antes de eu enviar seja o que for. O que não
passar, não sai daqui.

    python3 verificar.py

Sem argumentos verifica tudo. Com um caminho, só esse ficheiro.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent

# Os ficheiros que importam, por tipo.
MODULOS = ['server.js', 'server-drivers.js', 'partners.js', 'support.js',
           'support-shared.js', 'emailService.js', 'emailclient.js',
           'calendar.js', 'telegram.js', 'flights.js']

PAGINAS = ['callcentre/public/index.html', 'drivers-public/index.html',
           'render-site/support.html', 'render-site/myaccount.html',
           'render-site/maps/index.html', 'render-site/index.html',
           'render-site/checkout/index.html', 'render-site/agency.html']

SCRIPTS = ['callcentre/public/assets/desk.js']

problemas = []
avisos = []


def erro(ficheiro, msg):
    problemas.append(f'{ficheiro}: {msg}')


def aviso(ficheiro, msg):
    avisos.append(f'{ficheiro}: {msg}')


def ler(caminho):
    p = RAIZ / caminho
    return p.read_text(encoding='utf-8') if p.exists() else None


# ============================================================
# 1. SINTAXE
#
# O node --check trata os .js como CommonJS e não vê erros de
# sintaxe em módulos ES. Um import mal formado passava — e passou,
# até rebentar no arranque do Render.
# ============================================================

def sintaxe():
    for f in MODULOS:
        s = ler(f)
        if s is None:
            continue

        r = subprocess.run(
            ['node', '--input-type=module', '--check'],
            input=s, capture_output=True, text=True
        )

        if r.returncode != 0:
            primeira = r.stderr.strip().split('\n')
            linha = next((l for l in primeira if 'Error' in l), primeira[0])
            erro(f, f'sintaxe — {linha.strip()[:90]}')

    for f in SCRIPTS:
        s = ler(f)
        if s is None:
            continue

        r = subprocess.run(['node', '--check'], input=s,
                           capture_output=True, text=True)

        if r.returncode != 0:
            erro(f, 'sintaxe — ' + r.stderr.strip().split('\n')[0][:90])

    # O JavaScript dentro das páginas.
    for f in PAGINAS:
        s = ler(f)
        if s is None:
            continue

        for bloco in re.findall(r'<script>\n([\s\S]*?)</script>', s):
            if len(bloco.strip()) < 200:
                continue

            r = subprocess.run(
                ['node', '-e', 'new Function(require("fs").readFileSync(0,"utf8"))'],
                input=bloco, capture_output=True, text=True
            )

            if r.returncode != 0:
                erro(f, 'sintaxe no <script> — ' +
                     r.stderr.strip().split('\n')[-1][:80])
                break


# ============================================================
# 2. NOMES DUPLICADOS
#
# O erro que se repetiu três vezes. Duas funções com o mesmo nome:
# o JavaScript usa a última, e a primeira desaparece em silêncio.
# ============================================================

def duplicados():
    for f in MODULOS + SCRIPTS:
        s = ler(f)
        if s is None:
            continue

        # Só as do topo do ficheiro.
        #
        # Uma função dentro de outra pode repetir o nome: são
        # escopos diferentes, e é normal ter um "has" auxiliar em
        # duas funções distintas.
        #
        # O que colide são as do topo, onde o JavaScript usa a
        # última e a primeira desaparece.
        nomes = re.findall(r'^(?:export\s+)?(?:async\s+)?function (\w+)\s*\(',
                           s, re.M)

        vistos = {}
        for n in nomes:
            vistos[n] = vistos.get(n, 0) + 1

        for n, c in vistos.items():
            if c > 1:
                erro(f, f'função "{n}" definida {c} vezes')

    # As rotas, que colidem da mesma maneira.
    for f in ['server.js', 'support.js', 'partners.js', 'server-drivers.js']:
        s = ler(f)
        if s is None:
            continue

        rotas = re.findall(
            r"(?:app|router)\.(get|post|put|delete)\('([^']+)'", s)

        vistas = {}
        for metodo, caminho in rotas:
            chave = f'{metodo.upper()} {caminho}'
            vistas[chave] = vistas.get(chave, 0) + 1

        for chave, c in vistas.items():
            if c > 1:
                erro(f, f'rota "{chave}" declarada {c} vezes '
                        '(o Express usa a primeira)')

    # E os ids no HTML.
    for f in PAGINAS:
        s = ler(f)
        if s is None:
            continue

        # Só os do HTML, não os que o JS escreve dentro de
        # strings: um elemento substituido por outro com o mesmo id
        # é normal.
        so_html = re.sub(r'<script>[\s\S]*?</script>', '', s)

        ids = re.findall(r'id="([\w-]+)"', so_html)
        vistos = {}
        for i in ids:
            vistos[i] = vistos.get(i, 0) + 1

        for i, c in vistos.items():
            if c > 1:
                erro(f, f'id="{i}" repetido {c} vezes')


# ============================================================
# 3. RECURSÃO ACIDENTAL
#
# Uma substituição em massa fez o refDe() chamar-se a si próprio.
# Passou a leitura e rebentou em produção com "Maximum call stack
# size exceeded".
# ============================================================

def recursao():
    for f in MODULOS + SCRIPTS:
        s = ler(f)
        if s is None:
            continue

        for m in re.finditer(
                r'(?:export\s+)?(?:async\s+)?function (\w+)\s*\([^)]*\)\s*\{', s):
            nome = m.group(1)
            i = m.end()

            prof, j = 1, i
            while j < len(s) and prof > 0:
                if s[j] == '{':
                    prof += 1
                elif s[j] == '}':
                    prof -= 1
                j += 1

            corpo = s[i:j]

            # Curta e a chamar-se a si própria no return: quase de
            # certeza um acidente.
            if len(corpo) < 500 and re.search(
                    r'return\s+' + nome + r'\s*\(', corpo):
                erro(f, f'função "{nome}" chama-se a si própria no return')


# ============================================================
# 4. IDS QUE O JS PROCURA E O HTML NÃO TEM
# ============================================================

PARES = [
    ('callcentre/public/assets/desk.js', 'callcentre/public/index.html'),

]

def ids_em_falta():
    for js, html in PARES:
        s, h = ler(js), ler(html)
        if s is None or h is None:
            continue

        # O desk.js usa el(); as paginas do site usam $().
        procurados = set(re.findall(r"el\('([\w-]+)'\)", s))
        procurados |= set(re.findall(r"\$\('([\w-]+)'\)", s))
        existentes = set(re.findall(r'id="([\w-]+)"', h))

        # Os criados pelo próprio JS não contam.
        criados = set(re.findall(r"id=\"([\w-]+)\"'", s))
        criados |= set(re.findall(r"id=\\?'([\w-]+)\\?'", s))

        falta = sorted(procurados - existentes - criados)

        if falta:
            aviso(js, f'ids que o HTML não tem: {", ".join(falta[:8])}')

    # E dentro das páginas, onde o JS e o HTML vivem juntos.
    for f in PAGINAS:
        s = ler(f)
        if s is None:
            continue

        procurados = set(re.findall(r"\$\('([\w-]+)'\)", s))
        existentes = set(re.findall(r'id="([\w-]+)"', s))

        # Um id repetido pode ser o JS a substituir o elemento por
        # outro com o mesmo id. Não conta como duplicacao.
        falta = sorted(procurados - existentes)

        if falta:
            aviso(f, f'ids que o HTML não tem: {", ".join(falta[:8])}')


# ============================================================
# 5. COLUNAS INVENTADAS
#
# A família de erros mais cara: vehicle_class, return_of, stage,
# responded_at, sender_id, calendar_event_id.
#
# Compara o que o SQL usa com o que o código escreve. Não é
# infalível — nada aqui vê a base de dados a sério — mas apanha o
# caso comum de eu escrever um nome que nunca existiu em lado
# nenhum.
# ============================================================

def colunas():
    codigo = ''
    for f in MODULOS + SCRIPTS:
        s = ler(f)
        if s:
            codigo += s

    sqls = sorted((RAIZ / 'sql').glob('*.sql')) if (RAIZ / 'sql').exists() else []

    # As colunas que o código escreve ou lê, em qualquer sítio.
    conhecidas = set(re.findall(r'\b(\w+):\s', codigo))
    conhecidas |= set(re.findall(r"select\('([^']+)'", codigo))
    conhecidas |= set(re.findall(r"eq\('(\w+)'", codigo))
    conhecidas |= set(re.findall(r'\.(\w+)\b', codigo))

    # E as que os próprios SQL criam.
    for q in sqls:
        s = q.read_text(encoding='utf-8')
        conhecidas |= set(re.findall(r'add column if not exists (\w+)', s))
        conhecidas |= set(re.findall(r'^\s+(\w+) (?:text|uuid|int|bool|numeric|timestamptz|jsonb|smallint)',
                                     s, re.M))

    # Palavras que não são colunas.
    RESERVADAS = {
        'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true',
        'false', 'case', 'when', 'then', 'else', 'end', 'as', 'on',
        'join', 'left', 'inner', 'cross', 'union', 'all', 'order', 'by',
        'group', 'having', 'limit', 'offset', 'with', 'insert', 'into',
        'values', 'update', 'set', 'delete', 'returns', 'table', 'function',
        'language', 'security', 'definer', 'stable', 'immutable', 'begin',
        'declare', 'return', 'exists', 'count', 'sum', 'avg', 'min', 'max',
        'coalesce', 'now', 'interval', 'text', 'uuid', 'int', 'jsonb',
        'default', 'create', 'replace', 'drop', 'alter', 'add', 'column',
        'constraint', 'check', 'index', 'grant', 'execute', 'to', 'if',
        'distinct', 'filter', 'over', 'partition', 'lateral', 'using'
    }

    for q in sqls:
        # Os de diagnóstico não interessam: são para explorar.
        if 'diag' in q.name or 'comparar' in q.name or 'verificar' in q.name:
            continue

        s = q.read_text(encoding='utf-8')

        # As colunas referidas com prefixo de tabela: c.foo, b.bar
        usadas = set(re.findall(r'\b[a-z]\.(\w+)\b', s))
        usadas -= RESERVADAS

        # Os aliases que o proprio SQL define nao sao colunas:
        # "count(*) as aprovadas" cria um nome que so existe ali.
        usadas -= set(re.findall(r'\bas (\w+)\b', s))
        usadas -= set(re.findall(r"'(\w+)',", s))

        # E as tabelas de sistema do Postgres.
        if 'pg_' in s or 'information_schema' in s:
            usadas -= {
                'column_name', 'data_type', 'table_name', 'relname',
                'relkind', 'objid', 'refobjid', 'ev_class', 'indexrelid',
                'indisunique', 'indkey', 'indrelid', 'proname', 'oid',
                'relrowsecurity', 'relforcerowsecurity', 'policyname',
                'tablename', 'schemaname', 'ordinal_position'
            }

        desconhecidas = sorted(
            c for c in usadas
            if c not in conhecidas
            and len(c) > 3
            and not c.isupper()
        )

        if desconhecidas:
            aviso(f'sql/{q.name}',
                  'colunas que o código nunca usa — verificar: ' +
                  ', '.join(desconhecidas[:6]))


# ============================================================
# 6. EQUILÍBRIOS
# ============================================================

def equilibrios():
    for f in PAGINAS:
        s = ler(f)
        if s is None:
            continue

        abre = len(re.findall(r'<div\b', s))
        fecha = len(re.findall(r'</div>', s))

        if abre != fecha:
            erro(f, f'{abre} <div> para {fecha} </div>')

        estilo = re.search(r'<style>([\s\S]*)</style>', s)
        if estilo:
            c = estilo.group(1)
            if c.count('{') != c.count('}'):
                erro(f, f'CSS: {c.count("{")} chavetas abertas, '
                        f'{c.count("}")} fechadas')

    css = ler('callcentre/public/assets/desk.css')
    if css and css.count('{') != css.count('}'):
        erro('callcentre/public/assets/desk.css',
             f'{css.count("{")} chavetas abertas, {css.count("}")} fechadas')

    if (RAIZ / 'sql').exists():
        for q in sorted((RAIZ / 'sql').glob('*.sql')):
            s = q.read_text(encoding='utf-8')

            # Sem comentários nem strings: um parêntese dentro de
            # "close_chat(uuid, text, text)" num comentário não
            # desequilibra nada.
            limpo = re.sub(r'--[^\n]*', '', s)
            limpo = re.sub(r"'[^']*'", "''", limpo)

            if limpo.count('(') != limpo.count(')'):
                erro(f'sql/{q.name}',
                     f'{limpo.count("(")} parênteses abertos, '
                     f'{limpo.count(")")} fechados')

            # As aspas simples, fora dos blocos $$ onde vivem strings
            # com apóstrofos.
            fora = re.sub(r'\$\$[\s\S]*?\$\$', '', s)
            if fora.count("'") % 2 != 0:
                aviso(f'sql/{q.name}', 'número ímpar de aspas simples')


# ============================================================
# 7. FUNÇÕES SQL COM RETORNO ALTERADO
#
# "cannot change return type of existing function". Aconteceu duas
# vezes: no agent_day_metrics e no support_capacity.
# ============================================================

def retornos():
    if not (RAIZ / 'sql').exists():
        return

    for q in sorted((RAIZ / 'sql').glob('*.sql')):
        s = q.read_text(encoding='utf-8')

        # As que devolvem uma tabela e são criadas com "or replace"
        for m in re.finditer(
                r'create or replace function (\w+)\s*\([^)]*\)\s*\nreturns table',
                s):
            nome = m.group(1)

            if f'drop function if exists {nome}' not in s:
                aviso(f'sql/{q.name}',
                      f'{nome}() devolve uma tabela e não tem drop antes — '
                      'se as colunas mudarem, o Postgres recusa')


# ============================================================
# 8. RENAME SEM PROTEÇÃO
#
# O "rename column" não tem "if exists". Correr o ficheiro duas
# vezes dá erro na segunda, e um ficheiro que não se pode repetir é
# um ficheiro que se tem medo de correr.
# ============================================================

def renames():
    if not (RAIZ / 'sql').exists():
        return

    for q in sorted((RAIZ / 'sql').glob('*.sql')):
        s = q.read_text(encoding='utf-8')

        for m in re.finditer(r'^\s*alter table \w+\s*\n?\s*rename column',
                             s, re.M):
            i = m.start()
            antes = s[max(0, i - 600):i]

            if 'information_schema.columns' not in antes:
                aviso(f'sql/{q.name}',
                      'rename column sem verificar se a coluna existe — '
                      'o ficheiro não se pode correr duas vezes')
                break


# ============================================================
# CORRER
# ============================================================

def formulas_divergentes():
    """
    As cópias da fórmula de preços dão o mesmo?

    Existe em cinco sítios: precos.js e quatro páginas. Divergiram
    quatro vezes num dia — e cada divergência dá um preço na
    calculadora e outro no pagamento.

    Isto não compara o código: compara os NÚMEROS. Uma fórmula
    reescrita de outra maneira mas com os mesmos valores passa; uma
    com um 3.5 onde as outras têm 1.45 não passa.
    """
    import re

    paginas = {
        'precos.js': 'precos.js',
        'homepage': 'render-site/index.html',
        'booking': 'render-site/booking/index.html',
        'checkout': 'render-site/checkout/index.html',
    }

    encontradas = {}

    for nome, caminho in paginas.items():
        texto = ler(caminho)
        if texto is None:
            continue

        # a fórmula do resto do mundo
        m = re.search(r'Math\.max\(25,\s*\((\d+(?:\.\d+)?)\s*\+\s*\w+\s*\*\s*(\d+(?:\.\d+)?)\)\s*\*\s*(\d+(?:\.\d+)?)', texto)

        if m:
            encontradas[nome] = (m.group(1), m.group(2), m.group(3))

    if len(encontradas) < 2:
        return

    valores = set(encontradas.values())

    if len(valores) > 1:
        detalhe = '; '.join(
            f'{nome}: {v[0]} + km*{v[1]} * {v[2]}'
            for nome, v in encontradas.items()
        )

        erro('precos.js',
             'a fórmula genérica diverge entre páginas — '
             + detalhe +
             '. Um preço na calculadora e outro no pagamento.')


def classes_de_veiculo():
    """
    As classes que o site oferece são as que o servidor aceita?

    A validação do checkout teve uma lista à mão que não batia com
    a real: faltavam duas classes e tinha uma inventada. Quem
    escolhesse "Van + Sedan" não conseguia pagar.
    """
    import re

    pr = ler('precos.js')
    if pr is None:
        return

    m = re.search(r'VEHICLE_CLASSES\s*=\s*\{', pr)
    if not m:
        return

    i = m.end() - 1
    prof, k = 0, i
    while k < len(pr):
        if pr[k] == '{':
            prof += 1
        elif pr[k] == '}':
            prof -= 1
            if prof == 0:
                break
        k += 1

    fonte = set(re.findall(r'^\s+(\w+):\s*\{', pr[i:k+1], re.M))

    for nome, caminho in [
        ('booking', 'render-site/booking/index.html'),
        ('checkout', 'render-site/checkout/index.html'),
    ]:
        texto = ler(caminho)
        if texto is None:
            continue

        ids = set(re.findall(r"id:\s*'(\w+)'", texto))
        ids |= set(re.findall(r'^\s+(\w+):\s*\{\s*name:', texto, re.M))

        # só os que parecem classes
        ids = {x for x in ids if x in fonte or x in
               ('sedan', 'premium', 'van', 'van_sedan', 'two_vans', 'minibus')}

        fora = ids - fonte

        if fora:
            erro(caminho,
                 'oferece classes que o cálculo não conhece: '
                 + ', '.join(sorted(fora)))


def valores_por_omissao():
    """
    Um valor inicial que é um palpite.

    O trip nascia com isPT: true, e uma rota em Dublin era cobrada
    pela tabela do Algarve. O valor inicial de uma coisa que se vai
    calcular é null.
    """
    import re

    for caminho in ['render-site/booking/index.html',
                    'render-site/checkout/index.html']:
        texto = ler(caminho)
        if texto is None:
            continue

        m = re.search(r'var trip = \{[^}]*isPT:\s*(true|false)', texto)

        if m:
            erro(caminho,
                 f'trip nasce com isPT: {m.group(1)}. Devia ser null — '
                 'um palpite dá um preço errado em silêncio.')


def rotas_sem_protecao():
    """
    Uma rota com await fora de try devolve HTML sem CORS.

    O browser mostra "Failed to fetch", que não diz nada sobre a
    causa. Aconteceu no checkout: quinze pontos desprotegidos.
    """
    import re

    for caminho in ['server.js', 'server-drivers.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        if 'app.use((err, req, res, next)' not in texto:
            erro(caminho,
                 'sem apanhador global de erros — uma rota que lance '
                 'responde sem CORS, e o browser diz "Failed to fetch".')


def rpc_com_catch():
    """
    Um .catch() encadeado a um .rpc() do Supabase.

    O construtor do Supabase é um "thenable": tem .then, e o await
    funciona — mas nem todas as versões expõem .catch. A chamada
    rebenta com "rpc(...).catch is not a function".

    O pior é quando isso acontece DEPOIS do trabalho: o ticket
    fecha, o evento processa-se, e só a resposta se perde. O
    utilizador vê um erro e não sabe se pode repetir.

    Usa try/catch à volta do await.
    """
    import re

    for caminho in ['server.js', 'server-drivers.js', 'support.js',
                    'partners.js', 'supabaseclient.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        for m in re.finditer(r'\.rpc\([^;]{0,200}?\.catch\(', texto, re.S):
            linha = texto[:m.start()].count('\n') + 1

            erro(caminho,
                 f'linha {linha}: .catch() encadeado a .rpc(). O construtor '
                 'do Supabase nem sempre tem .catch — usa try/catch.')


def variaveis_de_fora():
    """
    Uma variável usada numa função e declarada noutra.

    No browser, cada id do documento cria uma variável global. Uma
    função que usa "passengers" sem o declarar apanha o ELEMENTO
    com esse id, não o número.

    Foi assim que o preço deixou de mudar com os passageiros: o
    multiplicador recebia um <input>.

    Isto procura funções que usam um nome que também é um id do
    HTML, sem o declararem.
    """
    import re

    for caminho in ['render-site/index.html',
                    'render-site/booking/index.html',
                    'render-site/checkout/index.html']:
        texto = ler(caminho)
        if texto is None:
            continue

        ids = set(re.findall(r'id="([a-zA-Z][\w-]*)"', texto))

        # só os que são nomes de variável plausíveis
        ids = {x for x in ids if re.fullmatch(r'[a-z][a-zA-Z]{3,}', x)}

        if not ids:
            continue

        for m in re.finditer(r'function (\w+)\s*\([^)]*\)\s*\{', texto):
            nome = m.group(1)
            j = m.end() - 1

            prof, k = 0, j
            while k < len(texto):
                if texto[k] == '{':
                    prof += 1
                elif texto[k] == '}':
                    prof -= 1
                    if prof == 0:
                        break
                k += 1

            corpo = texto[j:k]

            # sem comentários, para não apanhar prosa
            corpo = re.sub(r'/\*[\s\S]*?\*/', '', corpo)
            corpo = re.sub(r'//[^\n]*', '', corpo)

            # E as strings: "up to 4 passengers" não é um uso da
            # variável, é prosa. Sem isto, quase toda a função com
            # texto visível dava um aviso.
            corpo = re.sub(r"'(?:[^'\\]|\\.)*'", "''", corpo)
            corpo = re.sub(r'"(?:[^"\\]|\\.)*"', '""', corpo)
            corpo = re.sub(r'`(?:[^`\\]|\\.)*`', '``', corpo)

            declaradas = set(re.findall(r'\b(?:var|let|const)\s+(\w+)', corpo))
            declaradas |= set(re.findall(r'function \w+\s*\(([^)]*)\)', corpo)[0].split(',')) \
                if re.search(r'function \w+\s*\(', corpo) else set()

            # os parâmetros da própria função
            params = set(x.strip() for x in
                         (re.search(r'\(([^)]*)\)', m.group(0)).group(1) or '').split(','))

            for id_ in ids:
                if id_ in declaradas or id_ in params:
                    continue

                # usado como valor, não como string
                if re.search(r'(?<![\w.\'"])' + re.escape(id_) + r'(?![\w\'"])\s*[,)\]*+\-]', corpo):
                    aviso(caminho,
                          f'{nome}() usa "{id_}" sem o declarar, e existe um '
                          f'id="{id_}" no HTML — pode apanhar o elemento em '
                          'vez do valor.')


def promessas_sem_espera():
    """
    Uma função async chamada sem await nem .catch.

    A promessa rejeita em silêncio, e o Node mata o processo nas
    versões recentes. Um email que falha derruba o servidor.
    """
    import re

    for caminho in ['server.js', 'server-drivers.js', 'support.js',
                    'partners.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        # as funções async definidas no ficheiro
        locais = set(re.findall(r'async function (\w+)', texto))

        # e as importadas que sabemos serem async
        locais |= set(re.findall(r'^\s+(telegram\w+|send\w+|notify\w+),',
                                 texto, re.M))

        for fn in locais:
            for m in re.finditer(
                r'(?<![\w.])' + re.escape(fn) + r'\([^;]{0,200}?\);', texto
            ):
                trecho = m.group(0)
                antes = texto[max(0, m.start() - 30):m.start()]

                if 'await' in antes or 'return' in antes:
                    continue
                if '.catch(' in trecho or '.then(' in trecho:
                    continue

                linha = texto[:m.start()].count('\n') + 1

                aviso(caminho,
                      f'linha {linha}: {fn}() chamada sem await nem .catch — '
                      'uma rejeição não tratada pode derrubar o processo.')
                break


def numeros_magicos_de_preco():
    """
    Números da fórmula de preços escritos fora do precos.js.

    Cada um é uma cópia à espera de divergir. A 10 de setembro
    havia cinco, e quatro divergiram no mesmo dia.
    """
    import re

    pr = ler('precos.js')
    if pr is None:
        return

    # os números que aparecem nas fórmulas do precos.js
    formulas = re.findall(r'Math\.max\(\d+,\s*\([^)]*\)', pr)

    if not formulas:
        return

    paginas = [
        'render-site/index.html',
        'render-site/booking/index.html',
        'render-site/checkout/index.html',
        'render-site/seo/build-routes.js',
    ]

    com_formula = []

    for caminho in paginas:
        texto = ler(caminho)
        if texto is None:
            continue

        if re.search(r'Math\.max\(2[45],\s*\(', texto):
            com_formula.append(caminho)

    if len(com_formula) > 1:
        aviso('precos.js',
              'a fórmula de preços está copiada em '
              + str(len(com_formula)) + ' páginas: '
              + ', '.join(com_formula)
              + '. Cada cópia é uma que vai divergir — o servidor tem '
                'uma rota /api/price que devia responder por todas.')


def alarmes_ligados():
    """
    Uma função de alarme escrita e nunca chamada.

    O telegramNewPartner existiu meses sem ser chamado: um parceiro
    registava-se e ninguém sabia. Não dava erro nenhum.
    """
    import re

    tg = ler('telegram.js')
    if tg is None:
        return

    definidas = set(re.findall(r'export async function (telegram\w+)', tg))

    usos = set()
    for caminho in ['server.js', 'server-drivers.js', 'support.js',
                    'partners.js', 'support-shared.js']:
        texto = ler(caminho)
        if texto:
            usos |= set(re.findall(r'(telegram\w+)', texto))
            # os que passam pelo notify
            usos |= {'telegram' + x[0].upper() + x[1:]
                     for x in re.findall(r'notify\.(\w+)', texto)}

    orfas = definidas - usos - {'telegramTest'}

    for fn in sorted(orfas):
        erro('telegram.js',
             f'{fn}() está definida e nunca é chamada — '
             'um alarme que não dispara é o mesmo que não existir.')


def imports_entre_servicos():
    """
    Um ficheiro de um serviço importado pelo outro.

    Os dois serviços vivem em repositórios separados. O
    telegram.js está no da API; o server-drivers.js importou-o e o
    Render rebentou no arranque com ERR_MODULE_NOT_FOUND.

    O serviço não subia de todo — e isso não aparece em nenhum
    teste local, porque na pasta de trabalho os ficheiros estão
    todos juntos.

    Estes são os ficheiros que SÓ existem no repositório da API.
    """
    import re

    so_na_api = {
        'telegram.js',
        'emailService.js',
        'calendar.js',
        'flights.js',
        'precos.js',
        'testar-precos.js',
    }

    do_drivers = [
        'server-drivers.js', 'partners.js', 'support.js',
        'support-shared.js', 'emailclient.js', 'supabaseclient.js',
    ]

    for caminho in do_drivers:
        texto = ler(caminho)
        if texto is None:
            continue

        for m in re.finditer(r"from '\./([\w.-]+)'", texto):
            alvo = m.group(1)

            if alvo in so_na_api:
                linha = texto[:m.start()].count('\n') + 1

                erro(caminho,
                     f'linha {linha}: importa {alvo}, que vive no repositório '
                     'da API. O Render rebenta no arranque com '
                     'ERR_MODULE_NOT_FOUND e o serviço não sobe. '
                     'Pede à API por uma rota interna.')


def imports_que_nao_existem():
    """
    Um import de um nome que o ficheiro não exporta.

    O Node rebenta no arranque com "does not provide an export
    named X" — e o serviço não sobe de todo.

    Acontece sempre que se publica um ficheiro e não o outro: o
    server.js pede uma função que a versão antiga do
    emailService.js ainda não tem.

    Correr isto antes de publicar apanha-o em dois segundos.
    """
    import re, os

    for caminho in ['server.js', 'server-drivers.js', 'partners.js',
                    'support.js', 'support-shared.js', 'emailclient.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        for m in re.finditer(
            r"import \{([^}]+)\} from '\./([\w.-]+)'", texto, re.S
        ):
            alvo = m.group(2)
            destino = ler(alvo)

            if destino is None:
                continue

            # os nomes importados, sem comentários
            bloco = re.sub(r'//[^\n]*', '', m.group(1))
            bloco = re.sub(r'/\*[\s\S]*?\*/', '', bloco)

            nomes = set(
                x.strip().split(' as ')[0].strip()
                for x in bloco.split(',')
                if x.strip() and re.fullmatch(r'[\w\s]+(?: as \w+)?', x.strip())
            )

            exportadas = set(re.findall(
                r'export (?:async )?(?:function|const|let|var|class) (\w+)', destino
            ))

            # e as exportadas em bloco
            for m2 in re.finditer(r'export \{([^}]+)\}', destino):
                exportadas |= set(
                    x.strip().split(' as ')[-1].strip()
                    for x in re.sub(r'//[^\n]*', '', m2.group(1)).split(',')
                    if x.strip()
                )

            falta = {n for n in nomes if n and n not in exportadas}

            for n in sorted(falta):
                erro(caminho,
                     f'importa "{n}" de {alvo}, que não o exporta. '
                     'O Node rebenta no arranque e o serviço não sobe.')


def botoes_de_email():
    """
    Um botão de email sem endereço.

    O molde lê cta.href. Metade dos emails foi escrita com
    cta.url — e nesses o href saía vazio: o botão aparecia bonito
    e não ia a lado nenhum.

    Dez emails estiveram assim sem ninguém reparar, porque um
    botão morto não dá erro nenhum: não rebenta, não avisa, e o
    email chega com bom aspeto.

    O molde passou a aceitar os dois nomes. Isto vigia o resto: um
    cta sem endereço, ou com um endereço vazio.
    """
    import re

    texto = ler('emailService.js')
    if texto is None:
        return

    # o molde aceita os dois?
    aceita_os_dois = re.search(
        r'href="\$\{esc\(cta\.href \|\| cta\.url', texto
    ) is not None

    if not aceita_os_dois:
        aviso('emailService.js',
              'o molde lê só um nome do cta — se algum email usar o outro, '
              'o botão sai sem endereço e ninguém repara.')

    # e cada cta tem endereço?
    for m in re.finditer(r'cta: \{([^}]{0,300})\}', texto, re.S):
        bloco = m.group(1)

        if not re.search(r'\b(url|href):', bloco):
            linha = texto[:m.start()].count('\n') + 1

            erro('emailService.js',
                 f'linha {linha}: um botão de email sem url nem href — '
                 'aparece no email e não vai a lado nenhum.')

        # um endereço vazio é o mesmo que nenhum
        if re.search(r"\b(url|href):\s*''", bloco):
            linha = texto[:m.start()].count('\n') + 1

            erro('emailService.js',
                 f'linha {linha}: um botão de email com endereço vazio.')


def tabelas_de_preco():
    """
    As tabelas de preço são as mesmas em todo o lado?

    O servidor tinha tarifas italianas e as páginas não — uma rota
    em Roma mostrava 172 euros e era cobrada a 94. Não dava erro
    nenhum: cada lado calculava com o que tinha.

    Isto compara os NÚMEROS de cada tabela. Uma tabela reescrita
    de outra maneira mas com os mesmos valores passa; uma que
    falte, ou com um número diferente, não passa.
    """
    import re

    def tabela(texto, nome):
        m = re.search(r'(?:const |var )?' + nome + r'\s*=\s*([\[{])', texto)
        if not m:
            return None

        abre = m.group(1)
        fecha = ']' if abre == '[' else '}'
        i = texto.index(abre, m.start())
        prof, k = 0, i

        while k < len(texto):
            if texto[k] == abre:
                prof += 1
            elif texto[k] == fecha:
                prof -= 1
                if prof == 0:
                    break
            k += 1

        bloco = texto[i:k+1]

        # As strings saem: os acentos escapados (\u00fa) traziam
        # dígitos que não são preços, e faziam a comparação falhar
        # em tabelas idênticas.
        bloco = re.sub(r"'(?:[^'\\]|\\.)*'", "''", bloco)
        bloco = re.sub(r'"(?:[^"\\]|\\.)*"', '""', bloco)

        return re.findall(r'\d+\.?\d*', bloco)

    fonte = ler('precos.js')
    if fonte is None:
        return

    # O código destas páginas vive em /assets/ desde que saiu do
    # HTML: cada visita descarregava 150 KB. As tabelas foram com
    # ele, e esta verificação procurava no sítio antigo.
    paginas = {
        'booking': 'render-site/booking/index.html',
        'checkout': 'render-site/checkout/index.html',
    }

    for nome_tab in ['ES_ZONES', 'PT_ZONES', 'IT_ZONES',
                     'ES_FALLBACK', 'PT_FALLBACK', 'IT_FALLBACK']:
        na_fonte = tabela(fonte, nome_tab)

        if na_fonte is None:
            continue

        for nome_pag, caminho in paginas.items():
            texto = ler(caminho)
            if texto is None:
                continue

            na_pagina = tabela(texto, nome_tab)

            if na_pagina is None:
                erro(caminho,
                     f'não tem a tabela {nome_tab}, que o precos.js tem. '
                     'A página calcula um preço e o servidor cobra outro.')
                continue

            if na_pagina != na_fonte:
                erro(caminho,
                     f'a tabela {nome_tab} tem números diferentes do '
                     f'precos.js ({len(na_pagina)} vs {len(na_fonte)} '
                     'valores). Um dos dois está errado.')


def origens_permitidas():
    """
    Os domínios do projeto estão no CORS?

    O portal dos motoristas chamou a API para definir a
    palavra-passe e o browser recusou: drivers.airportlink.app não
    estava na lista de origens.

    O erro que se vê é "Failed to fetch", que não diz nada sobre a
    causa.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    m = re.search(r'ALLOWED_ORIGINS\s*=\s*\[([\s\S]{0,900}?)\]', texto)

    if not m:
        aviso('server.js', 'não encontrei a lista ALLOWED_ORIGINS')
        return

    lista = m.group(1)

    precisam = [
        'drivers.airportlink.app',
        'www.airportlink.app',
    ]

    for dominio in precisam:
        if dominio not in lista:
            erro('server.js',
                 f'{dominio} não está nas origens permitidas. '
                 'Os pedidos desse domínio são recusados e o browser '
                 'diz "Failed to fetch".')


def campos_inventados():
    """
    Um campo que o objeto nao tem.

    O checkout chamava fare(km, mult, isPT, c.id) — mas as classes
    do checkout sao um objeto indexado por nome e nao tem campo
    "id". O c.id era undefined, e sem ele o preco caia no
    multiplicador generico em vez do da zona.

    A van em Ibiza mostrava 84 euros e o servidor cobrava 73. Onze
    euros por reserva, sem erro nenhum no ecra.

    Isto verifica os acessos a campos das tabelas de classes.
    """
    import re

    for caminho in ['render-site/checkout/index.html',
                    'render-site/booking/index.html',
                    'render-site/index.html']:
        texto = ler(caminho)
        if texto is None:
            continue

        m = re.search(r'CLASSES\s*=\s*([\[{])', texto)
        if not m:
            continue

        abre = m.group(1)
        fecha = ']' if abre == '[' else '}'
        i2 = texto.index(abre, m.start())
        prof, k = 0, i2

        while k < len(texto):
            if texto[k] == abre:
                prof += 1
            elif texto[k] == fecha:
                prof -= 1
                if prof == 0:
                    break
            k += 1

        bloco = texto[i2:k+1]

        # os campos que as entradas tem
        campos = set(re.findall(r'(\w+):\s*', bloco))

        # Sem comentarios nem strings: "c.id" escrito numa
        # explicacao nao e um acesso.
        codigo = re.sub(r'/\*[\s\S]*?\*/', '', texto)
        codigo = re.sub(r'//[^\n]*', '', codigo)
        codigo = re.sub(r"'(?:[^'\\]|\\.)*'", "''", codigo)
        codigo = re.sub(r'"(?:[^"\\]|\\.)*"', '""', codigo)

        # e os que o codigo le
        for m2 in re.finditer(r'\bc\.(\w+)\b', codigo):
            campo = m2.group(1)

            if campo in campos:
                continue

            linha = codigo[:m2.start()].count('\n') + 1

            erro(caminho,
                 f'perto da linha {linha}: le c.{campo}, e as entradas de CLASSES '
                 f'nao tem esse campo (tem: {", ".join(sorted(campos)[:6])}). '
                 'O valor e undefined e nao da erro nenhum.')


def upsert_sem_indice():
    """
    Um upsert com onConflict numa coluna sem indice unico.

    O Postgres recusa com "no unique or exclusion constraint
    matching the ON CONFLICT specification" — e o supabase-js
    devolve isso como um objeto de erro que ninguem verifica.

    A linha nao e escrita, e a vida segue ate outra coisa rebentar
    a apontar para ela. Foi assim que uma reserva falhou com
    "violates foreign key constraint": o contacto nunca tinha sido
    criado.

    As colunas que sabemos nao ter indice unico.
    """
    import re

    SEM_INDICE = {
        'contacts': ['email'],
    }

    for caminho in ['server.js', 'server-drivers.js', 'partners.js',
                    'support.js', 'support-shared.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        for tabela, colunas in SEM_INDICE.items():
            for m in re.finditer(
                r"from\('" + tabela + r"'\)\s*\.upsert\([\s\S]{0,400}?onConflict:\s*'(\w+)'",
                texto
            ):
                coluna = m.group(1)

                if coluna not in colunas:
                    continue

                linha = texto[:m.start()].count('\n') + 1

                erro(caminho,
                     f'linha {linha}: upsert em {tabela} com '
                     f"onConflict: '{coluna}', e essa coluna nao tem indice "
                     'unico. O Postgres recusa e a linha nao e escrita.')


def erro_ignorado_do_supabase():
    """
    Uma escrita no Supabase cujo erro ninguem le.

    O supabase-js nao lanca: devolve { data, error }. Uma escrita
    que falha sem ninguem olhar para o error passa por bem
    sucedida — e o problema aparece tres passos a frente, noutra
    operacao, com uma mensagem que nao diz a causa.

    Isto procura insert, update, upsert e delete cujo resultado
    nao e guardado em lado nenhum.
    """
    import re

    for caminho in ['server.js', 'server-drivers.js', 'partners.js',
                    'support.js', 'support-shared.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        # Os comentarios sao substituidos por espacos do mesmo
        # tamanho, e nao apagados: assim o numero de linha que
        # calculamos e o do ficheiro, e nao o de um texto
        # encolhido.
        def brancos(m):
            return re.sub(r'[^\n]', ' ', m.group(0))

        codigo = re.sub(r'/\*[\s\S]*?\*/', brancos, texto)
        codigo = re.sub(r'//[^\n]*', brancos, codigo)

        for m in re.finditer(
            r"(^|\n)\s*await supabase\s*\.from\('(\w+)'\)\s*"
            r"\.(insert|update|upsert|delete)\(",
            codigo
        ):
            # Guardado numa variavel? Entao o erro pode ser lido.
            antes = codigo[max(0, m.start() - 40):m.start() + 10]
            if '=' in antes or 'return' in antes:
                continue

            linha = codigo[:m.start()].count('\n') + 1
            tabela = m.group(2)
            operacao = m.group(3)

            # Um insert que falha perde a linha inteira; um update
            # que marca uma data perde uma data. Sao ambos erros,
            # mas so o primeiro perde uma reserva.
            grave = operacao in ('insert', 'upsert') or tabela in (
                'bookings', 'contacts', 'driver_partners'
            ) and operacao == 'delete'

            if grave:
                erro(caminho,
                     f'linha {linha}: {operacao} em {tabela} sem ler o error. '
                     'Se falhar, a linha nao e escrita e ninguem sabe — '
                     'ate outra coisa rebentar a apontar para ela.')
            else:
                aviso(caminho,
                      f'linha {linha}: {operacao} em {tabela} sem ler o error.')


def sessao_stripe_incompleta():
    """
    Uma reserva construida a partir de uma sessao do Stripe sem
    verificar se ela foi completada.

    Uma sessao de checkout nasce quando a pessoa carrega em
    "continuar" — antes de ver o formulario do cartao. Se ela
    fechar a janela nessa altura, a sessao fica como "open" ou
    "expired" e nunca houve reserva.

    Sem verificar o status, cria-se uma reserva de alguem que
    desistiu. Aconteceu com tres, e foi preciso apaga-las a mao.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    # As funcoes que leem uma sessao e escrevem uma reserva
    for m in re.finditer(r'(async )?function (\w*[Ss]ession\w*|repair\w+)\s*\(', texto):
        nome = m.group(2)
        i = m.start()

        prof, j = 0, texto.index('{', i)
        k = j
        while k < len(texto):
            if texto[k] == '{':
                prof += 1
            elif texto[k] == '}':
                prof -= 1
                if prof == 0:
                    break
            k += 1

        corpo = texto[i:k]

        # escreve em bookings?
        if not re.search(r"from\('bookings'\)\s*\.(insert|upsert)", corpo):
            continue

        if "session.status" not in corpo:
            erro('server.js',
                 f'{nome}() cria uma reserva a partir de uma sessao do '
                 'Stripe sem verificar session.status. Uma sessao "open" ou '
                 '"expired" e alguem que desistiu, nao alguem que reservou.')


def stripe_setup_sem_cliente():
    """
    Uma sessao de checkout em modo setup sem Customer.

    O customer_email guarda o cartao e NAO cria cliente nenhum. O
    stripe_customer_id fica null — e a cobranca de 48 horas antes
    precisa de um cliente E de um metodo de pagamento.

    Viagem feita, cartao guardado, e zero cobrado. Foi assim com
    tres reservas ate alguem reparar.

    O customer_creation nao serve: so existe no modo payment. O
    cliente tem de ser criado a mao antes da sessao.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    for m in re.finditer(r"mode:\s*'setup'", texto):
        # O bloco da sessao, a volta
        ini = max(0, m.start() - 600)
        fim = min(len(texto), m.start() + 900)
        bloco = texto[ini:fim]

        cria = 'stripe.customers.create' in bloco
        usa = re.search(r'customer:\s*\w+\.id|customer:\s*cliente', bloco)

        if cria and usa:
            continue

        linha = texto[:m.start()].count('\n') + 1

        erro('server.js',
             f'linha {linha}: sessao em mode setup sem criar Customer. '
             'O cartao fica guardado sem cliente, e o charge-due nunca '
             'consegue cobrar.')


def cobranca_sem_o_que_precisa():
    """
    A cobranca agendada precisa de tres coisas na reserva.

    O customer, o metodo de pagamento, e o modo. Se o checkout nao
    gravar qualquer uma delas, a reserva nunca e cobrada — e nada
    no ecra diz isso.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    # O que o charge-due exige
    i = texto.find("'/api/tasks/charge-due'")
    if i < 0:
        return

    prof, j = 0, texto.index('{', texto.index('async', i))
    k = j
    while k < len(texto):
        if texto[k] == '{':
            prof += 1
        elif texto[k] == '}':
            prof -= 1
            if prof == 0:
                break
        k += 1

    cobranca = texto[i:k]

    exigidos = []
    for campo in ['stripe_customer_id', 'stripe_payment_method_id',
                  'payment_mode']:
        if campo in cobranca:
            exigidos.append(campo)

    # E o que o webhook grava
    i2 = texto.find('const bookingRow')
    if i2 < 0:
        return

    prof, j2 = 0, texto.index('{', i2)
    k2 = j2
    while k2 < len(texto):
        if texto[k2] == '{':
            prof += 1
        elif texto[k2] == '}':
            prof -= 1
            if prof == 0:
                break
        k2 += 1

    gravados = texto[i2:k2]

    for campo in exigidos:
        if campo not in gravados:
            erro('server.js',
                 f'o charge-due exige {campo} e o webhook nao o grava. '
                 'A reserva fica por cobrar para sempre.')


def status_mentiroso_no_stripe():
    """
    Um metadado a dizer "paid" numa reserva de pagar depois.

    A base fica certa — o webhook escreve 'confirmed' — mas quem
    for ao painel do Stripe investigar um problema le "paid" e
    conclui o contrario do que aconteceu.

    O metadado tem de ser escrito DEPOIS de se saber se o pagar
    depois foi autorizado.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    # o metadata.status fixo em 'paid' sem correcao a seguir
    m = re.search(r"^\s*status:\s*'paid',\s*$", texto, re.M)

    if not m:
        return

    corrige = 'metadata.status = payLater' in texto

    if not corrige:
        linha = texto[:m.start()].count('\n') + 1

        aviso('server.js',
              f'linha {linha}: o metadado status vai sempre como "paid", '
              'mesmo no pagar depois. Quem investigar no Stripe le o '
              'contrario do que aconteceu.')


def usado_antes_de_existir():
    """
    Uma variavel usada antes da linha que a declara.

    Com const e let, isso e um TDZ error: "Cannot access X before
    initialization". Nao e um aviso — e uma excecao que rebenta a
    funcao inteira.

    Aconteceu num alarme de preco: o log mencionava a agencia, e o
    agent so era procurado quarenta linhas abaixo. O checkout
    deixou de funcionar para toda a gente.

    A sintaxe passa. So rebenta a correr.
    """
    import re

    def limpar(t):
        t = re.sub(r'/\*[\s\S]*?\*/',
                   lambda m: re.sub(r'[^\n]', ' ', m.group(0)), t)
        t = re.sub(r'//[^\n]*', lambda m: ' ' * len(m.group(0)), t)
        t = re.sub(r"'(?:[^'\\]|\\.)*'",
                   lambda m: "'" + ' ' * (len(m.group(0)) - 2) + "'", t)
        t = re.sub(r'"(?:[^"\\]|\\.)*"',
                   lambda m: '"' + ' ' * (len(m.group(0)) - 2) + '"', t)
        t = re.sub(r'`(?:[^`\\]|\\.)*`',
                   lambda m: '`' + ' ' * (len(m.group(0)) - 2) + '`', t)
        return t

    for caminho in ['server.js', 'server-drivers.js', 'partners.js',
                    'support.js', 'support-shared.js']:
        texto = ler(caminho)
        if texto is None:
            continue

        for m in re.finditer(r'(?:async )?function (\w+)\s*\(', texto):
            nome = m.group(1)
            i2 = m.start()

            prof, j = 0, texto.index('{', i2)
            k = j
            while k < len(texto):
                if texto[k] == '{':
                    prof += 1
                elif texto[k] == '}':
                    prof -= 1
                    if prof == 0:
                        break
                k += 1

            if k - i2 < 400:
                continue

            corpo = limpar(texto[i2:k])

            # as constantes declaradas no corpo
            for d in re.finditer(r'\n\s*const (\w+)\s*=', corpo):
                var = d.group(1)

                if len(var) < 4:
                    continue

                # usada antes?
                antes = corpo[:d.start()]

                # o parametro da funcao tem o mesmo nome? entao e outra coisa
                params = re.search(r'\(([^)]*)\)', corpo[:corpo.index('{')])
                if params and re.search(r'\b' + var + r'\b', params.group(1)):
                    continue

                # A mesma variavel pode ser declarada duas vezes em
                # blocos diferentes — dentro de um if, de um for. Cada
                # bloco tem o seu, e o de cima nao e o de baixo.
                #
                # Se o nome aparecer num const anterior, ha dois
                # blocos e nao ha erro nenhum.
                if re.search(r'\bconst ' + var + r'\s*=', antes):
                    continue

                uso = re.search(r'(?<![\w.$])' + var + r'(?![\w:])', antes)

                if uso:
                    linha = texto[:i2].count('\n') + antes[:uso.start()].count('\n') + 1

                    erro(caminho,
                         f'linha {linha}: {nome}() usa "{var}" antes do const '
                         'que o declara. Isso rebenta a funcao inteira com '
                         '"Cannot access before initialization".')
                    break


def distancia_do_browser():
    """
    A distancia enviada pelo browser, usada sem limite.

    O servidor mede a rota no Google e depois usa a que o browser
    mandou. Sem um limite, um pedido com distance_km: 1 numa rota
    de 300 km paga o minimo — e a viagem acontece na mesma.

    Nao e preciso ma intencao: um campo que fica a "..." enquanto
    o mapa calcula ja deu 26 euros numa viagem de 87.

    O que se procura: o aviso existe e o valor e usado a seguir,
    sem condicao.
    """
    import re

    texto = ler('server.js')
    if texto is None:
        return

    i2 = texto.find('distance mismatch')
    if i2 < 0:
        return

    # o que vem depois do aviso
    bloco = texto[i2:i2 + 900]

    # atribuicao sem estar dentro de um else
    atribui = re.search(r'distanceKm\s*=\s*kmDoCliente', bloco)

    if not atribui:
        return

    antes = bloco[:atribui.start()]

    if 'else' not in antes:
        linha = texto[:i2].count('\n') + 1

        erro('server.js',
             f'linha {linha}: o aviso de distance mismatch dispara e a '
             'distancia do browser e usada na mesma. Um pedido com '
             'distance_km: 1 numa rota longa paga o minimo.')


def main():
    testes = [
        ('sintaxe', sintaxe),
        ('nomes duplicados', duplicados),
        ('recursão acidental', recursao),
        ('ids em falta', ids_em_falta),
        ('colunas inventadas', colunas),
        ('equilíbrios', equilibrios),
        ('retornos SQL', retornos),
        ('renames sem proteção', renames),

        # As que nasceram do dia 10 de setembro, em que cinco
        # cópias da fórmula de preços divergiram quatro vezes.
        ('fórmulas divergentes', formulas_divergentes),
        ('classes de veículo', classes_de_veiculo),
        ('valores por omissão', valores_por_omissao),
        ('rotas sem proteção', rotas_sem_protecao),
        ('rpc com .catch', rpc_com_catch),
        ('variáveis de fora', variaveis_de_fora),
        ('promessas sem espera', promessas_sem_espera),
        ('cópias da fórmula', numeros_magicos_de_preco),
        ('alarmes ligados', alarmes_ligados),
        ('imports entre serviços', imports_entre_servicos),
        ('imports inexistentes', imports_que_nao_existem),
        ('botões de email', botoes_de_email),
        ('tabelas de preço', tabelas_de_preco),
        ('origens do CORS', origens_permitidas),
        ('campos inventados', campos_inventados),
        ('upsert sem indice', upsert_sem_indice),
        ('erros do supabase ignorados', erro_ignorado_do_supabase),
        ('sessao do stripe incompleta', sessao_stripe_incompleta),
        ('setup sem cliente', stripe_setup_sem_cliente),
        ('cobranca sem o que precisa', cobranca_sem_o_que_precisa),
        ('status mentiroso no stripe', status_mentiroso_no_stripe),
        ('usado antes de existir', usado_antes_de_existir),
        ('distancia do browser', distancia_do_browser),
    ]

    for nome, fn in testes:
        try:
            fn()
        except Exception as e:
            avisos.append(f'[{nome}] a verificação falhou: {e}')

    print()

    if problemas:
        print(f'PARA CORRIGIR ({len(problemas)})')
        print()
        for p in problemas:
            print('  ' + p)
        print()

    if avisos:
        print(f'para olhar ({len(avisos)})')
        print()
        for a in avisos:
            print('  ' + a)
        print()

    if not problemas and not avisos:
        print('  tudo limpo')
        print()

    # Só os problemas travam. Os avisos são para eu ler, não para
    # bloquear — um aviso que trava tudo acaba por ser ignorado.
    return 1 if problemas else 0


if __name__ == '__main__':
    sys.exit(main())
