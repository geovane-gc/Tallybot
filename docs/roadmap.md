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

Hoje `saldo` mostra `fatura_mes_fmt`, que é o gasto do mês corrente naquele
cartão. Não é a fatura real: uma compra de 28/07 num cartão que fecha dia 25 cai
na fatura de agosto, não na de julho.

As colunas `dia_fechamento` e `dia_vencimento` já existem no schema, sem uso. O
que falta é uma função de ciclo — dado um cartão e uma data, em qual fatura a
compra cai — e um subcomando `fatura` que agrupe por ciclo em vez de por mês
civil. É o próximo passo mais útil para quem vive de cartão.

## Vários usuários

O schema não tem coluna de usuário. Dois IDs na allowlist dividiriam a mesma
carteira, o que pode até ser o desejado num casal com finanças conjuntas — mas é
bom saber que é o comportamento.

Para separar: `usuario_id` nas tabelas, filtro em todas as consultas, e o gateway
já entrega o ID do remetente do Telegram para o agente. É uma migration nova em
`MIGRATIONS` (nunca editar a versão 1, que já está aplicada) mais o filtro no
`fin.ts`.

## Import de extrato

Registrar tudo à mão dá trabalho no começo. Um `fin.ts import` que aceite OFX
(que todo banco brasileiro exporta) ou CSV do Nubank preencheria meses de
histórico de uma vez.

A parte difícil não é ler o arquivo, é a deduplicação: reimportar o mesmo extrato
não pode duplicar lançamento. O caminho é um hash de idempotência sobre
`(data, valor, descrição normalizada)`, comparado antes de inserir.

## Gráficos

O `resumo` já devolve os dados agregados. Gerar um PNG de pizza por categoria ou
de linha por mês, e mandar como imagem no Telegram, é bem visual num relatório
mensal.

Sem dependências novas: dá para montar SVG na mão a partir dos números e
converter, ou usar a skill `xlsx` do Hermes para produzir planilha com gráfico.

## Previsão de fim de mês

Com histórico suficiente, projetar: "no ritmo atual você fecha o mês em R$ 4.200,
R$ 300 acima do seu limite". Média dos últimos N dias × dias restantes, mais as
recorrentes ainda não lançadas — que o banco já conhece, via `proxima_data`.

Isso encaixa bem no `alertas`, avisando **antes** de estourar em vez de depois.

## Ajustando o comportamento

Nem toda melhoria é código. O jeito do bot conversar está em `hermes/SOUL.md`, e
mudanças ali valem imediatamente após `make restart`:

- Muito ou pouco verboso? A seção "Como você se comunica".
- Perguntando demais? A seção "Quando perguntar" no `SKILL.md`.
- Categorizando errado com frequência? Acrescente os termos que você usa em
  `skills/financas/references/categorias.md`.
- Quer relatório em outro horário? `hermes/cron-jobs.sh`, depois
  `make cron-install`.

Como a skill é montada read-write, o próprio agente pode ajustá-la durante o uso —
e as mudanças aparecem como diff no git, para você revisar antes de manter.
