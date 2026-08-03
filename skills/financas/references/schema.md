# Schema do banco

SQLite em `/opt/data/financas/financas.db` (no host: `data/financas/financas.db`).

Use isto só para consultas que a CLI não cobre. Para qualquer coisa que um
subcomando resolva, **use o subcomando** — ele valida entrada, cuida de fuso e
mantém a integridade. SQL cru não valida nada.

Nunca escreva no banco por SQL. `INSERT`/`UPDATE`/`DELETE` à mão contornam as
validações e produzem dados que os relatórios não sabem interpretar.

## Convenções

- **Dinheiro:** inteiro em centavos, sempre positivo. `2750` = R$ 27,50. O
  campo `tipo` define a direção do dinheiro, não o sinal.
- **Datas:** texto `YYYY-MM-DD`, no fuso `America/Sao_Paulo`.
- **Timestamps:** ISO-8601 com offset.
- **Booleanos:** inteiro 0/1.

## Tabelas

### `lancamentos` — o registro central

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | INTEGER PK | É o número que o usuário vê e usa para corrigir |
| `tipo` | TEXT | `despesa` \| `receita` \| `transferencia` |
| `valor_centavos` | INTEGER | Sempre > 0 (CHECK) |
| `descricao` | TEXT | Obrigatório |
| `data` | TEXT | Data do fato, não do registro |
| `categoria_id` | INTEGER FK | Nulo em transferência |
| `conta_id` | INTEGER FK | Conta de origem |
| `conta_destino_id` | INTEGER FK | Só em transferência; obrigatório nela (CHECK) |
| `observacao` | TEXT | |
| `origem` | TEXT | `telegram` \| `recorrente` \| `cron` \| `import` |
| `recorrente_id` | INTEGER FK | Preenchido quando gerado por despesa fixa |
| `parcela_num` / `parcela_total` | INTEGER | `3` e `12` em "parcela 3/12" |
| `grupo_parcelas` | TEXT | Mesmo hash em todas as parcelas de uma compra |
| `criado_em` / `atualizado_em` | TEXT | |

### `contas`

`id`, `nome` (único), `tipo` (`conta`, `cartao`, `dinheiro`, `poupanca`,
`investimento`, `voucher`), `instituicao`, `dia_fechamento`, `dia_vencimento`,
`limite_centavos`, `saldo_inicial_centavos`, `ativa`, `criada_em`.

Conta desativada (`ativa = 0`) sai das listagens mas preserva o histórico.

### `categorias`

`id`, `nome`, `parent_id` (nulo = raiz), `tipo` (`despesa`, `receita`, `ambos`),
`emoji`, `ativa`. Único em `(nome, parent_id)`.

Hierarquia de dois níveis. Filtrar ou orçar uma raiz inclui as filhas.

### `orcamentos`

`id`, `categoria_id` (**nulo = teto total do mês**), `mes` (`YYYY-MM`; **nulo =
vale para todos os meses**), `limite_centavos`, `alerta_pct`, `criado_em`.

Quando existem os dois para a mesma categoria, o específico do mês vence.

### `recorrentes`

`id`, `descricao`, `tipo`, `valor_centavos`, `categoria_id`, `conta_id`,
`frequencia` (`mensal`, `semanal`, `anual`), `dia`, `proxima_data`, `fim`,
`ativa`, `criada_em`.

`recorrente aplicar` gera lançamentos até hoje e avança `proxima_data`. É
idempotente por `(recorrente_id, data)`.

### `metas`

`id`, `nome` (único), `valor_alvo_centavos`, `valor_atual_centavos`, `prazo`,
`ativa`, `criada_em`.

### `tags` e `lancamento_tags`

Muitos-para-muitos. `lancamento_tags` cascateia ao apagar o lançamento.

### `alertas_enviados`

`(chave, mes, nivel)` como PK, mais `enviado_em`. É o que impede o cron de
avisar duas vezes sobre o mesmo limite. `nivel` é `atencao` ou `estourado` —
subir de um para o outro conta como alerta novo.

### `config`

Pares chave/valor: `moeda`, `timezone`, `conta_padrao`.

### `schema_version`

Uma linha por migration aplicada. É o que torna `init` seguro de rodar sempre.

## A view `v_lancamentos`

Já traz os JOINs resolvidos — use ela, não a tabela crua:

`id`, `tipo`, `valor_centavos`, `descricao`, `data`, `observacao`, `origem`,
`parcela_num`, `parcela_total`, `grupo_parcelas`, `recorrente_id`, `criado_em`,
`atualizado_em`, `categoria_id`, `categoria`, `categoria_pai`,
`categoria_emoji`, `conta_id`, `conta`, `conta_tipo`, `conta_destino_id`,
`conta_destino`.

## Consultas de exemplo

Para rodar SQL de leitura:

    node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('/opt/data/financas/financas.db');
    console.log(db.prepare('<SQL>').all());
    "

Não passe `{ readOnly: true }`: o banco está em modo WAL, e uma conexão
somente-leitura falha quando o arquivo `-shm` não existe (ela não tem permissão
para criá-lo). A garantia de não estragar nada vem de rodar só `SELECT`.

**Gasto por dia da semana** (0 = domingo):

    SELECT strftime('%w', data) AS dow, SUM(valor_centavos)/100.0
    FROM lancamentos WHERE tipo='despesa'
    GROUP BY dow ORDER BY dow;

**Estabelecimentos mais frequentes:**

    SELECT descricao, COUNT(*) n, SUM(valor_centavos)/100.0 total
    FROM lancamentos WHERE tipo='despesa'
    GROUP BY LOWER(descricao) HAVING n > 2 ORDER BY total DESC LIMIT 10;

**Evolução mensal:**

    SELECT substr(data,1,7) mes,
           SUM(CASE WHEN tipo='despesa' THEN valor_centavos ELSE 0 END)/100.0 saiu,
           SUM(CASE WHEN tipo='receita' THEN valor_centavos ELSE 0 END)/100.0 entrou
    FROM lancamentos GROUP BY mes ORDER BY mes;

**Parcelas que ainda vão vencer:**

    SELECT descricao, parcela_num, parcela_total, data, valor_centavos/100.0
    FROM lancamentos
    WHERE parcela_total IS NOT NULL AND data > date('now','localtime')
    ORDER BY data;

## Migrations

Definidas em `scripts/db.ts`, na lista `MIGRATIONS`, como
`(versao, sql)`. Para evoluir o schema: adicione uma tupla nova com a versão
seguinte — nunca edite uma migration já aplicada — e rode `fin.ts init`.
