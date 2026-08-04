# Como usar

Não há comandos a memorizar. Escreva como você falaria com alguém.

## A primeira mensagem: o código de acesso

Antes de qualquer coisa, o bot pede um código:

```
você:  oi
Tally: 🔒 Antes de falar de dinheiro eu preciso confirmar quem é você.
       Me manda o código de acesso.

você:  <o código combinado>
Tally: ✅ Tudo certo, agora é só me contar seus gastos.
```

É uma vez só. Depois disso ele não pergunta mais.

Cinco tentativas erradas travam o acesso, e aí só o dono do servidor libera (com
`make logout-all`). Se o bot voltar a pedir o código do nada, foi esse comando
que rodou — é só digitar de novo, nada foi perdido.

O bot nunca repete nem confirma o código. Se você perguntar qual é, ele diz que
não tem.

## Duas pessoas, dois caixas

O mesmo bot atende duas pessoas, e cada uma tem o próprio caixa: contas,
categorias, orçamentos, metas, despesas fixas e lançamentos.

Na prática, conversando com ele:

- As duas podem ter uma conta chamada "Nubank". São contas diferentes.
- Você só vê os seus números. Relatório, busca, saldo, export: tudo sai filtrado
  pelo seu caixa, e citar o número de um lançamento da outra pessoa não funciona —
  o bot responde que não achou aquele lançamento.
- O bot não soma nem compara as duas. Se você perguntar quanto a outra pessoa
  gastou, ele diz que só cuida dos números de cada um separadamente.

Você não precisa se identificar. O bot sabe quem está escrevendo porque o gateway
do Telegram informa, não porque alguém digitou um ID.

**Uma ressalva honesta:** isso garante que os dois caixas não se misturam, não que
um seja secreto para o outro. As duas pessoas compartilham um container e um
arquivo de banco, e o bot tem acesso ao terminal — quem souber pedir consegue
chegar ao caixa do outro. É um bot para duas pessoas que confiam uma na outra. Se
a expectativa for outra, veja
[isolamento real](deploy.md#as-duas-pessoas-não-estão-isoladas-uma-da-outra).

## Registrar gastos

```
uber 27
mercado 234,56
89,90 no ifood
gastei 50 no cinema ontem
pix 80 pro mercado
almoço 32 no cartão do nubank
posto 200
farmácia 45,90
```

O bot confirma em uma linha, com o número do lançamento no fim:

```
✅ R$ 27,00 · Uber · hoje · Nubank (#142)
```

Guarde esse número mentalmente só até a próxima mensagem — é como você corrige.

### Vários de uma vez

```
mercado 200, farmácia 45 e uber 18
```

```
✅ Registrei 3:
• R$ 200,00 · Mercado (#150)
• R$ 45,00 · Farmácia (#151)
• R$ 18,00 · Uber (#152)
```

### Datas

```
uber 27 ontem
mercado 180 anteontem
aluguel 1500 dia 5
cinema 40 em 28/07
```

### Parcelado

```
notebook 3600 em 12x no nubank
sofá 1200 parcelado em 3
```

### Receitas

```
recebi 7500 de salário
caiu 1200 do freela
entrou 89 de cashback
vendi a bicicleta por 800
```

Palavras como *recebi*, *caiu*, *entrou*, *salário*, *vendi* fazem o bot entender
que é entrada. Sem elas, ele assume despesa.

### Transferências

```
transferi 500 da conta pra poupança
paguei a fatura do nubank, 1234,56
saquei 200
```

Transferência não conta como gasto nem receita — só move o dinheiro de lugar. É
assim que se registra pagamento de fatura: os gastos do cartão já foram lançados
um por um quando aconteceram; lançar a fatura como despesa contaria tudo duas
vezes.

## Corrigir

Referindo-se ao último lançamento:

```
não, foi 37
era no cartão
isso foi ontem
era mercado, não restaurante
apaga
```

Um lançamento antigo:

```
apaga o lançamento 142
muda o 142 pra 55 reais
cancela aquele parcelamento do notebook
```

## Consultar

```
quanto gastei esse mês?
quanto gastei hoje?
quanto gastei com comida?
quanto gastei em transporte na semana passada?
quanto tenho na conta?
qual meu saldo?
quanto devo no cartão?
meus últimos 10 gastos
gastos acima de 100 reais esse mês
quanto gastei em julho?
o que eu gastei no ifood?
```

## Relatórios

```
me manda o relatório do mês
relatório da semana
fechamento de julho
como foi meu mês passado?
compara esse mês com o passado
```

O relatório vem assim:

```
📊 Resumo — este mês
01/08 a 03/08

💸 Gastos: R$ 1.724,46
💰 Entradas: R$ 7.500,00
🟢 Resultado: R$ 5.775,54
📉 8% abaixo do período anterior (R$ 150,00)

Onde o dinheiro foi:
🏠 Moradia — R$ 1.234,56 (72%)
🛍️ Compras — R$ 400,00 (23%)
🍽️ Alimentação — R$ 89,90 (5%)

Maiores gastos:
• Aluguel — R$ 1.234,56 (02/08)
• Notebook — R$ 400,00 (03/08)

Orçamentos:
🟡 Alimentação em 90%: R$ 89,90 de R$ 100,00
```

## Orçamentos

```
limite de 500 pra alimentação
não quero gastar mais de 5 mil por mês
limite de 300 em lazer, me avisa em 70%
como estão meus limites?
tira o limite de lazer
```

O limite numa categoria grande cobre as filhas: teto em *Alimentação* soma
mercado, restaurante, delivery, padaria e café.

Quando um gasto faz você cruzar o aviso, ele avisa na hora, junto da
confirmação — e não repete o mesmo aviso várias vezes no mesmo mês.

## Contas e cartões

```
cadastra meu cartão do nubank, vence dia 10, limite 5 mil
cadastra minha conta do itaú
cadastra meu vr como voucher
usa o itaú como conta padrão
minhas contas
```

Sem dizer a conta, o gasto vai para a conta padrão. Corrigir depois é uma
mensagem; por isso o bot não pergunta a conta a cada lançamento.

Em cartão de crédito, saldo negativo é o quanto você deve.

## Despesas fixas

```
meu aluguel é 1500 todo dia 5
netflix 44,90 todo dia 20
spotify 22 mensal
academia 120 todo dia 8
minhas despesas fixas
cancela a netflix
```

Elas são lançadas automaticamente às 6h do dia certo. Ao cadastrar, a primeira
cobrança automática é a **próxima** — se hoje é dia 12 e você cadastra algo do
dia 5, o automático começa no mês que vem. O bot avisa e oferece lançar o do mês
atual à mão.

## Metas

```
quero juntar 15 mil pra viajar até junho
guardei 800 pra viagem
como estão minhas metas?
```

Ele calcula quanto falta e quanto você precisa guardar por mês para bater o
prazo.

## Export

```
me manda meus gastos do mês em planilha
exporta julho
```

Vem um CSV que abre direto no Excel em português — separador `;`, vírgula
decimal, acentos corretos.

## Categorias

```
minhas categorias
cria uma categoria de doações
```

Já vêm 17 categorias e ~70 subcategorias. Você não precisa criar nada para
começar. O bot escolhe a categoria sozinho; se errar, corrija e siga.

## Relatórios automáticos

Sem ninguém pedir, e sempre na conversa privada de cada um:

| Quando | O que chega |
|---|---|
| 06:00 | As despesas fixas do dia, já lançadas |
| 09h, 15h e 21h | Alerta, só se algum limite apertou |
| 21:00 | Resumo do dia (silencioso se não houve gasto) |
| Domingo, 20:00 | Fechamento da semana |
| Dia 1º, 09:00 | Fechamento do mês, com a planilha anexada |

Quem não autenticou não recebe nada, porque não há caixa para relatar. Depois que
alguém novo entra, o dono do servidor precisa rodar `make cron-install` de novo
para criar os jobs daquela pessoa.

## O que ele não faz

- **Não lê áudio nem foto de comprovante** nesta versão (ver
  [roadmap.md](roadmap.md)).
- **Não julga seus gastos.** Ele mostra número, não dá sermão. Se você quiser
  opinião, pergunte — aí ele responde com base nos seus dados.
- **Não inventa valor.** Se a mensagem estiver ambígua, ele pergunta em vez de
  chutar. Preferi um bot que pergunta a um bot que registra errado.
- **Não conversa espontaneamente.** Fora dos relatórios agendados e dos alertas
  de limite, ele só fala quando você fala.
- **Não mostra o dinheiro da outra pessoa.** Nenhum relatório, saldo ou busca
  atravessa de um caixa para o outro. (Isso é uma regra que ele cumpre, não uma
  parede — ver a ressalva em [Duas pessoas, dois caixas](#duas-pessoas-dois-caixas).)

## Atalhos pelo terminal

Para quem tem acesso ao servidor. Consultas rápidas, sem gastar requisição do
modelo — e cada uma precisa saber de qual caixa você está falando:

```bash
make users                       # lista quem está cadastrado, com os IDs
make balance TG_USER=123456789
make summary TG_USER=123456789
make report  TG_USER=123456789
make export  TG_USER=123456789
```

`TG_USER` e não `USER`: o `make` importa o ambiente, e `USER` já contém o seu nome
de login no shell.

Ou a CLI completa. Fora de uma sessão do Telegram não existe identidade nenhuma,
então `--user` é obrigatório:

```bash
node skills/finance/scripts/fin.ts --db data/finance/tally.db --help
node skills/finance/scripts/fin.ts --db data/finance/tally.db \
    ls --period 30d --category Alimentação --user 123456789
```
