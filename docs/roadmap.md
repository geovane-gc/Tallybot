# Evoluções

O que ficou fora desta versão, e o que cada coisa custaria. A ordem é do mais
fácil para o mais trabalhoso.

## Entrada por áudio

**Custo: uma linha de config.** Ficou fora porque escolhemos um bot de texto, não
por limitação técnica.

O Hermes já transcreve mensagens de voz do Telegram automaticamente, usando
`faster-whisper` **local e gratuito** — sem chave de API. O provider default é
`local`, e o modelo (~150 MB) baixa sozinho no primeiro áudio.

```yaml
# hermes/config.yaml
stt:
  enabled: true      # está false hoje
  language: "pt"
```

Depois `make restart`. Mandar "gastei duzentos e cinquenta num tênis novo" por
áudio passa a funcionar: o gateway transcreve, e o texto chega ao agente como se
você tivesse digitado.

Se a transcrição local ficar lenta na sua máquina, o Groq tem Whisper em tier
gratuito (`GROQ_API_KEY` no `.env`, `stt.provider: groq`).

## Foto de comprovante

**Custo: trocar o modelo, mais alguns ajustes no skill.**

O modelo atual (`nvidia/nemotron-3-ultra-550b-a55b:free`) não tem visão. Dos 14
modelos gratuitos da OpenRouter, quatro têm visão **e** tool calling:

| modelo | contexto |
|---|---|
| `google/gemma-4-31b-it:free` | 262k |
| `google/gemma-4-26b-a4b-it:free` | 262k |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256k |
| `nvidia/nemotron-nano-12b-v2-vl:free` | 128k |

Trocar `model.default` em `hermes/config.yaml` e `make restart`. Depois vale
acrescentar ao `SKILL.md` uma seção sobre ler comprovante: onde procurar o valor
total (não o subtotal, nem o troco), como identificar o estabelecimento, e o que
fazer quando a foto está ilegível — **perguntar**, nunca chutar um valor.

Há também a skill `ocr-and-documents`, que já vem na imagem do Hermes, para
extrair texto de imagem sem depender da visão do modelo.

Uma observação: a lista de modelos gratuitos muda. Para conferir o que está
disponível hoje:

```bash
curl -s https://openrouter.ai/api/v1/models | node --input-type=module -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  for (const m of JSON.parse(s).data) {
    if (!m.id.endsWith(":free")) continue;
    const tools = (m.supported_parameters ?? []).includes("tools");
    const visao = (m.architecture?.input_modalities ?? []).includes("image");
    console.log(m.id.padEnd(52), tools ? "tools" : "-", visao ? "visão" : "-");
  }
});'
```

## Fatura de cartão de verdade

Hoje `balance` mostra `month_bill_fmt`, que é o gasto do mês corrente naquele
cartão. Não é a fatura real: uma compra de 28/07 num cartão que fecha dia 25 cai
na fatura de agosto, não na de julho.

As colunas `closing_day` e `due_day` já existem no schema, sem uso. O
que falta é uma função de ciclo — dado um cartão e uma data, em qual fatura a
compra cai — e um subcomando `bill` que agrupe por ciclo em vez de por mês
civil. É o próximo passo mais útil para quem vive de cartão.

## Mais de duas pessoas

A separação por pessoa já existe: `user_id` em toda tabela de caixa, identidade
lida de `HERMES_SESSION_USER_ID` e `UNIQUE` por usuário. Nada no `fin.ts` conta
pessoas, então o schema aguenta quantas linhas houver em `users`.

O que é feito para duas é o **acesso**: existe um código de acesso só, igual para
todos. Isso significa que não há como revogar o acesso de uma pessoa sem forçar
todas a redigitar (`make logout-all` é global). Para um grupo maior valeria um
código por pessoa ou um convite de uso único: uma tabela `invites` com
`(code_hash, used_at)`, e `auth login` consumindo o convite em vez de comparar com
a variável de ambiente. O resto do caminho — a fan-out do cron, o `--user`, os
índices — já é agnóstico à quantidade.

O limite mais duro, porém, não é de quantidade: é que todas as pessoas dividem um
container e um agente com shell, então nenhuma fica isolada das outras
([deploy.md](deploy.md#as-duas-pessoas-não-estão-isoladas-uma-da-outra)). Isso
escala mal com desconhecidos. Para um grupo em que as pessoas não confiam umas nas
outras, o desenho certo não é mais uma coluna no banco — é uma instância por
pessoa, ou um serviço de verdade entre o agente e os dados, com o agente sem
acesso direto ao arquivo.

## Despesa conjunta e rateio

Hoje não existe nada compartilhado, por decisão: o bot nunca mostra o número de um
para o outro, e não há soma do casal. Isso deixa "quanto nós dois gastamos de
mercado esse mês?" sem resposta.

O caminho menos invasivo é não mexer na separação e acrescentar por cima: uma
tabela de vínculo entre lançamentos de pessoas diferentes (ou um `split_group`,
como já existe `installment_group`), mais um subcomando que só some o que foi
explicitamente marcado como conjunto. A parte difícil não é o SQL, é o produto:
quem pode marcar, o que aparece para quem, e como o bot conta metade de um gasto
sem contar o gasto inteiro duas vezes. Vale desenhar antes de codar.

## Import de extrato

Registrar tudo à mão dá trabalho no começo. Um `fin.ts import` que aceite OFX
(que todo banco brasileiro exporta) ou CSV do Nubank preencheria meses de
histórico de uma vez.

A parte difícil não é ler o arquivo, é a deduplicação: reimportar o mesmo extrato
não pode duplicar lançamento. O caminho é um hash de idempotência sobre
`(date, amount, descrição normalizada)`, comparado antes de inserir.

## Gráficos

O `summary` já devolve os dados agregados. Gerar um PNG de pizza por categoria ou
de linha por mês, e mandar como imagem no Telegram, é bem visual num relatório
mensal.

Sem dependências novas: dá para montar SVG na mão a partir dos números e
converter, ou usar a skill `xlsx` do Hermes para produzir planilha com gráfico.

## Previsão de fim de mês

Com histórico suficiente, projetar: "no ritmo atual você fecha o mês em R$ 4.200,
R$ 300 acima do seu limite". Média dos últimos N dias × dias restantes, mais as
recorrentes ainda não lançadas — que o banco já conhece, via `next_date`.

Isso encaixa bem no `alerts`, avisando **antes** de estourar em vez de depois.

## Ajustando o comportamento

Nem toda melhoria é código. O jeito do bot conversar está em `hermes/SOUL.md`, e
mudanças ali valem imediatamente após `make restart`:

- Muito ou pouco verboso? A seção "Como você se comunica".
- Perguntando demais? A seção "Quando perguntar" no `SKILL.md`.
- Categorizando errado com frequência? Acrescente os termos que você usa em
  `skills/finance/references/categories.md`.
- Quer relatório em outro horário? `hermes/cron-jobs.sh`, depois
  `make cron-install`. Os horários valem para as duas pessoas: o script gera o
  mesmo conjunto de cinco jobs para cada uma.

A skill é montada read-only por padrão. Removendo o `:ro` do
`docker-compose.yml`, o próprio agente passa a poder ajustá-la durante o uso, e as
mudanças aparecem como diff no git para você revisar antes de manter. É uma troca
consciente, não um brinde — o outro lado está em
[deploy.md](deploy.md#a-skill-é-montada-read-only): ele também pode alterar o
código que roda na próxima mensagem, incluindo as checagens de identidade.
