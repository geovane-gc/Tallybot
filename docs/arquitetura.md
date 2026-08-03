# Arquitetura

## As peças

```
   Telegram
      │  long polling (só tráfego de saída, nenhuma porta aberta)
      ▼
┌─────────────────────────────────────────────────────────┐
│ container financas-bot   (nousresearch/hermes-agent)    │
│                                                          │
│  gateway ──► agente ──► modelo (OpenRouter, nemotron)    │
│                 │                                        │
│                 │ toolset `terminal`                     │
│                 ▼                                        │
│         node fin.ts <subcomando>                         │
│                 │                                        │
│                 ▼                                        │
│         SQLite  /opt/data/financas/financas.db           │
└─────────────────────────────────────────────────────────┘
      │
      ▼  volume
   ./data no host   (config, sessões, memórias, banco)
```

O container é a unidade de deploy inteira. Não há serviço separado, banco
externo, fila nem porta de entrada — o gateway conversa com a API do Telegram por
long polling, então nem firewall precisa ser tocado.

## Onde vive cada instrução

Três camadas, com propósitos distintos. Entender a divisão é o que evita mexer no
arquivo errado.

| Camada | Arquivo | Quando é carregado | Para quê |
|---|---|---|---|
| Persona | `hermes/SOUL.md` | **Toda** sessão, automático | Quem o bot é, como escreve, e o caminho rápido de lançamento |
| Referência | `skills/financas/SKILL.md` | Sob demanda (`skill_view`) | Todos os subcomandos e as regras completas |
| Detalhe | `skills/financas/references/*.md` | Sob demanda, por arquivo | Taxonomia, parsing PT-BR, relatórios, schema |

**Por que dividir assim.** O Hermes injeta o `SOUL.md` em toda sessão, mas a
skill só entra no contexto quando o agente pede. Registrar um gasto é 90% das
mensagens; se esse fluxo estivesse só na skill, cada "uber 27" gastaria um turno
extra num `skill_view` — e turno extra, no tier free da OpenRouter, é requisição
da cota diária. Então o caminho quente mora no `SOUL.md`, e a cauda longa
(orçamentos, metas, recorrentes, export) fica na skill.

Não existe chave de configuração no Hermes para pré-carregar uma skill em sessões
de gateway — conferi no `config_defaults.py`. O `--skill` do `cron create` cobre
o caso dos relatórios agendados, e é por isso que os cron jobs o usam.

## A regra central: o modelo não calcula

Toda aritmética de dinheiro, data, percentual e orçamento vive no `fin.ts`. O
modelo decide **o que** registrar; nunca **como** calcular.

Isso não é preciosismo. O Hermes deliberadamente **não** coloca a data atual no
prompt do sistema — ele instrui o agente a rodar `date` no terminal quando
precisar (`agent/prompt_builder.py`). Um modelo tentando resolver "ontem" de
cabeça, sem saber que dia é hoje, erraria. Então `--data ontem` é passado
literalmente e resolvido pelo script, no fuso de São Paulo.

O mesmo vale para valores: `--valor "1.234,56"` chega cru, e o parser trata o
formato brasileiro. Pedir ao modelo para "converter para float" seria convidar o
erro.

## Por que TypeScript sem dependências

A imagem do Hermes traz Node 26. Isso dá três coisas de graça:

- **`node fin.ts` roda direto**, porque o Node 26 remove os tipos nativamente.
  Sem `tsc`, sem `tsx`, sem bundler, sem passo de build entre editar e rodar.
- **`node:sqlite` é embutido**, então não há `better-sqlite3` para compilar nem
  módulo nativo para quebrar em troca de arquitetura.
- **`node --test` é embutido**, então a suíte roda sem framework instalado.

Consequência prática: `node_modules` não existe neste projeto. Os dois
`package.json` só declaram `"type": "module"` — o da raiz para ergonomia de
desenvolvimento, e o de `skills/financas/` porque a skill é montada sozinha em
`/opt/data/skills/financas` dentro do container, sem enxergar a raiz do repo.

Os tipos pagam por si num lugar específico: `Centavos` é um tipo marcado
(`number & { __marca }`), então passar reais onde se espera centavos não compila.
É a classe de erro mais fácil de cometer em código financeiro.

## Contrato entre agente e ferramenta

Toda chamada devolve JSON, sempre com a mesma forma:

```json
{ "ok": true,  "lancamento": { … } }
{ "ok": false, "erro": "Conta \"Nubank\" não existe. Rode `conta list`…" }
```

Duas propriedades importam:

**As mensagens de erro são escritas para o usuário final**, em português, falando
de dinheiro e não de SQL. O agente pode repassá-las direto. Erro do `parseArgs`
também é traduzido, e a mensagem lista as opções aceitas naquele subcomando — se
o modelo inventa `--moeda`, ele recebe de volta o que existe.

**A resposta do `add` já traz o orçamento afetado.** Se o gasto cruzou o limite, o
campo `orcamento` vem com `situacao: "atencao"` na mesma resposta. O agente avisa
sem uma segunda chamada, economizando uma requisição em cada lançamento que
importa.

## Modelo de dados

Nove tabelas, uma view. O detalhe completo está em
[`skills/financas/references/schema.md`](../skills/financas/references/schema.md).

Quatro decisões que moldam as consultas:

**Centavos inteiros.** Nunca float, em nenhuma coluna.

**Categorias em dois níveis.** `Alimentação > Delivery`. Filtrar ou orçar a raiz
inclui as filhas — sem isso, um teto em "Alimentação" ignoraria tudo que foi
lançado em "Delivery" e nunca fecharia com a soma das partes.

**Transferência é um tipo de lançamento**, não duas linhas. Fica fora dos totais
de despesa e receita: mover dinheiro entre contas suas não é gasto. É assim que
pagamento de fatura de cartão é registrado sem contar o gasto duas vezes.

**Parcelas são lançamentos reais**, um por mês, unidos por `grupo_parcelas`. Não
são um campo "12x" numa linha só. Assim a parcela cai no mês em que vence e o
relatório de março mostra o que de fato pesa em março. A divisão preserva o
centavo: R$ 100 em 3× vira 33,34 + 33,33 + 33,33.

## Deduplicação de alertas

O cron checa limites três vezes ao dia. Sem controle, você receberia "Alimentação
em 85%" às 9h, 15h e 21h, todos os dias até o fim do mês.

A tabela `alertas_enviados` tem `(chave, mes, nivel)` como chave primária, e
`alertas --marcar` registra o que já foi avisado. Subir de `atencao` para
`estourado` conta como alerta novo, porque é informação nova.

Quando não há nada a dizer, `alertas` devolve `silent: true` e o agente responde
apenas `[SILENT]` — marcador que o Hermes reconhece e não entrega. Um bot que
notifica sem motivo é um bot que você silencia.

## Fuso horário

Três camadas, cada uma resolvida onde importa:

1. **Container** roda com `TZ=America/Sao_Paulo` (definido no compose). Sem isso,
   um cron agendado para 21h dispararia às 18h de Brasília.
2. **`fin.ts`** usa `Intl.DateTimeFormat` com `timeZone: "America/Sao_Paulo"`
   para descobrir "hoje", independente do TZ do processo.
3. **Aritmética de calendário** usa `Date.UTC` sobre os componentes da data, não
   o fuso local. Somar um mês a 31/01 dá 28/02, e não uma data inválida.

## Fluxo de uma mensagem

```
"89,90 no ifood ontem no nubank"
   │
   ├─ gateway do Telegram valida o remetente contra TELEGRAM_ALLOWED_USERS
   ├─ SOUL.md já está no contexto: o agente sabe o caminho rápido
   ├─ terminal: node fin.ts add --valor 89,90 --descricao "iFood"
   │                            --categoria Delivery --conta Nubank --data ontem
   │     ├─ parseValor("89,90")  -> 8990 centavos
   │     ├─ parseData("ontem")   -> 2026-08-02 (fuso de São Paulo)
   │     ├─ resolverCategoria    -> Delivery (subcategoria vence a raiz)
   │     ├─ resolverConta        -> Nubank
   │     ├─ INSERT
   │     └─ statusOrcamentoDaCategoria -> { situacao: "atencao", … }
   │
   └─ "✅ R$ 89,90 · Delivery · ontem · Nubank (#88)
       🟡 Alimentação: R$ 324,46 de R$ 400,00 este mês."
```

Duas chamadas de modelo no total: uma para decidir o comando, outra para redigir a
confirmação lendo o JSON.

## Limites conhecidos

**Rate limit, não custo.** O modelo é gratuito, mas a OpenRouter limita ~50
requisições/dia sem crédito na conta. Com 2 a 4 requisições por mensagem, isso dá
uns 15 lançamentos diários. US$ 10 comprados uma vez levam o limite a ~1000/dia.

**Modelo free erra mais.** `max_turns: 30` e os `tool_loop_guardrails` existem
para que um erro do modelo não vire um loop que queima a cota. Se ele começar a
escolher comandos errados, trocar `model.default` por
`google/gemma-4-31b-it:free` é uma linha em `hermes/config.yaml`.

**Um usuário.** O schema não tem coluna de usuário. Vários IDs na allowlist
compartilhariam a mesma carteira. Para uso familiar, seria preciso adicionar
`usuario_id` nas tabelas e filtrar por ele.

**Sem áudio nem foto** nesta versão — ver [roadmap.md](roadmap.md), que descreve
o que cada um exigiria.
