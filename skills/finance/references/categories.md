# Categories and where each expense belongs

The database ships seeded with the tree below. Category names are in Portuguese
on purpose: they are data the user reads in every report, so they follow the
bot's language rather than the codebase's. You do not need to create anything for
day-to-day use.

## The tree

| Category | Subcategories |
|---|---|
| 🍽️ Alimentação | Mercado, Restaurante, Delivery, Padaria, Café |
| 🚗 Transporte | Uber/99, Combustível, Estacionamento, Transporte público, Manutenção |
| 🏠 Moradia | Aluguel, Condomínio, Luz, Água, Gás, Internet, IPTU |
| 💊 Saúde | Farmácia, Consulta, Exame, Plano de saúde, Academia |
| 🎉 Lazer | Streaming, Bar, Cinema, Viagem, Jogos, Eventos |
| 🛍️ Compras | Roupas, Eletrônicos, Casa, Presentes |
| 📚 Educação | Curso, Livros, Mensalidade, Certificação |
| 🔁 Assinaturas | Software, Streaming, Nuvem, Telefonia |
| 🔧 Serviços | Cabeleireiro, Lavanderia, Reparos, Assinatura profissional |
| 🧾 Impostos e taxas | Imposto, Tarifa bancária, Multa, Juros |
| 🐾 Pets | Ração, Veterinário, Petshop |
| 👨‍👩‍👧 Família | Filhos, Escola, Mesada, Ajuda familiar |
| 📈 Investimentos | Aporte, Resgate, Dividendos |
| 💳 Dívidas | Fatura de cartão, Empréstimo, Financiamento |
| ❓ Outros | — |
| 💰 Salário *(income)* | Salário, 13º, Férias, Bônus |
| 💵 Renda extra *(income)* | Freelance, Venda, Aluguel recebido, Reembolso, Cashback |

Always prefer the **subcategory**: `--category Delivery` rather than
`--category Alimentação`. Reports roll up to the root automatically, so you gain
detail without losing the overview.

## Everyday Brazilian terms

These are the merchants and words the user actually types. Keep them in mind
before reaching for `Outros`.

**Alimentação**
`ifood`, `rappi`, `delivery`, `pedido` → Delivery ·
`mercado`, `supermercado`, `carrefour`, `pão de açúcar`, `assaí`, `compras do mês` → Mercado ·
`almoço`, `janta`, `jantar`, `restaurante`, `comi fora`, `rodízio` → Restaurante ·
`café`, `starbucks`, `cafeteria` → Café ·
`padaria`, `pão`, `salgado` → Padaria

**Transporte**
`uber`, `99`, `táxi`, `taxi`, `corrida`, `indriver` → Uber/99 ·
`gasolina`, `álcool`, `etanol`, `posto`, `combustível`, `diesel`, `shell`, `ipiranga` → Combustível ·
`ônibus`, `metrô`, `bilhete único`, `passagem`, `brt`, `trem` → Transporte público ·
`estacionamento`, `zona azul`, `valet` → Estacionamento ·
`revisão`, `pneu`, `mecânico`, `oficina`, `lavagem`, `ipva` → Manutenção

**Moradia**
`aluguel` → Aluguel · `condomínio` → Condomínio ·
`luz`, `energia`, `enel`, `cemig`, `light` → Luz ·
`água`, `sabesp`, `saneamento` → Água ·
`gás`, `botijão`, `comgás` → Gás ·
`internet`, `vivo fibra`, `net`, `claro`, `wifi` → Internet ·
`iptu` → IPTU

**Saúde**
`farmácia`, `drogaria`, `remédio`, `medicamento`, `droga raia`, `pacheco` → Farmácia ·
`médico`, `consulta`, `dentista`, `psicólogo`, `terapia` → Consulta ·
`exame`, `laboratório`, `sangue`, `raio-x` → Exame ·
`plano de saúde`, `unimed`, `amil`, `bradesco saúde`, `sulamérica` → Plano de saúde ·
`academia`, `smartfit`, `gympass`, `crossfit`, `pilates` → Academia

**Lazer**
`netflix`, `spotify`, `disney`, `hbo`, `max`, `prime video`, `youtube premium` → Streaming
(but see the note on Assinaturas below) ·
`bar`, `cerveja`, `balada`, `boteco`, `chopp` → Bar ·
`cinema`, `filme`, `ingresso` → Cinema ·
`viagem`, `hotel`, `airbnb`, `passagem aérea`, `hospedagem` → Viagem ·
`jogo`, `steam`, `playstation`, `xbox`, `game` → Jogos ·
`show`, `festival`, `evento`, `teatro` → Eventos

**Compras**
`roupa`, `camiseta`, `calça`, `tênis`, `sapato`, `zara`, `renner`, `shein` → Roupas ·
`celular`, `notebook`, `fone`, `monitor`, `tv`, `eletrônico`, `kabum` → Eletrônicos ·
`móvel`, `decoração`, `panela`, `cama`, `utensílio`, `casa` → Casa ·
`presente`, `aniversário`, `lembrança` → Presentes

**Assinaturas**
`aws`, `google cloud`, `github`, `openai`, `chatgpt`, `claude`, `notion`, `figma` → Software ·
`icloud`, `google one`, `dropbox`, `backup` → Nuvem ·
`vivo`, `tim`, `claro`, `celular`, `plano`, `recarga` → Telefonia

**Serviços**
`cabeleireiro`, `barbeiro`, `corte`, `salão`, `manicure` → Cabeleireiro ·
`lavanderia` → Lavanderia · `encanador`, `eletricista`, `conserto`, `reparo` → Reparos

**Impostos e taxas**
`imposto`, `darf`, `irpf`, `mei`, `das` → Imposto ·
`tarifa`, `anuidade`, `taxa do banco` → Tarifa bancária ·
`multa` → Multa · `juros`, `mora`, `rotativo` → Juros

**Income**
`salário`, `pagamento`, `contracheque`, `holerite` → Salário ·
`13º`, `décimo terceiro` → 13º · `férias` → Férias · `bônus`, `plr` → Bônus ·
`freela`, `freelance`, `bico`, `projeto`, `consultoria` → Freelance ·
`vendi`, `venda`, `olx`, `enjoei` → Venda ·
`reembolso`, `estorno`, `devolução` → Reembolso ·
`cashback`, `cesta`, `pontos` → Cashback

## Judgement calls

**Streaming: Lazer or Assinaturas?** Both exist. Pick one and **stay
consistent** — inconsistency is what ruins a report. The convention here:
entertainment (Netflix, Disney, HBO, Spotify) goes to **Lazer > Streaming**; work
tooling (GitHub, AWS, Claude, Notion) goes to **Assinaturas > Software**.

**Paying a credit card bill is not a new expense** — the individual purchases
were already logged when they happened. Record it as a **transfer** from the
account to the card:

    add --type transfer --amount 1234,56 --description "Pagamento fatura Nubank" \
        --account "Itaú" --dest-account Nubank

Logging it as an expense would count the spending twice and inflate the month.

**PIX is a payment method, not a category.** Categorise by what was bought:
"pix 80 pro mercado" is Mercado. For a transfer to a person with nothing in
return (helping someone, splitting a bill), use `Família > Ajuda familiar` or
`Outros`, and name the person in the description.

**An investment is still the user's money** — not spending. Record it as a
transfer to the investment account if one exists; otherwise as
`Investimentos > Aporte`.

**Money lent to someone** is not an expense (they expect it back). Use `Outros`
with the tag `emprestimo` and make it explicit in the description.

**A cash withdrawal** is a transfer from the account to `Carteira`, not an
expense. The spending comes later, when the cash is used.

## Creating a new category

Only when something recurring fits nowhere:

    fin.ts category add --name "Doações" --type expense --emoji 🤝
    fin.ts category add --name "Uber Eats" --parent Alimentação

Do not create a category for a one-off purchase — use `Outros` and a good
description. A bloated tree is worse than an imprecise category.
