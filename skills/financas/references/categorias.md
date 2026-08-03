# Categorias e como encaixar cada gasto

O banco já vem semeado com a árvore abaixo. Você não precisa criar nada para o
dia a dia.

## A árvore

| Categoria | Subcategorias |
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
| 💰 Salário *(receita)* | Salário, 13º, Férias, Bônus |
| 💵 Renda extra *(receita)* | Freelance, Venda, Aluguel recebido, Reembolso, Cashback |

Prefira sempre a **subcategoria**: `--categoria Delivery` em vez de
`--categoria Alimentação`. Os relatórios agrupam na raiz automaticamente, então
você ganha detalhe sem perder a visão geral.

## Termos do dia a dia

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
(mas veja a nota sobre Assinaturas abaixo) ·
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

**Receitas**
`salário`, `pagamento`, `contracheque`, `holerite` → Salário ·
`13º`, `décimo terceiro` → 13º · `férias` → Férias · `bônus`, `plr` → Bônus ·
`freela`, `freelance`, `bico`, `projeto`, `consultoria` → Freelance ·
`vendi`, `venda`, `olx`, `enjoei` → Venda ·
`reembolso`, `estorno`, `devolução` → Reembolso ·
`cashback`, `cesta`, `pontos` → Cashback

## Decisões que dão dúvida

**Streaming: Lazer ou Assinaturas?** Ambas existem. Escolha uma e **mantenha a
escolha** — inconsistência é o que estraga relatório. A convenção aqui é:
entretenimento (Netflix, Disney, HBO, Spotify) vai em **Lazer > Streaming**;
ferramenta de trabalho (GitHub, AWS, Claude, Notion) vai em
**Assinaturas > Software**.

**Pagamento de fatura de cartão** não é despesa nova — os gastos já foram
lançados individualmente quando aconteceram. Registre como **transferência**
da conta para o cartão:

    add --tipo transferencia --valor 1234,56 --descricao "Pagamento fatura Nubank" \
        --conta "Itaú" --conta-destino Nubank

Lançar como despesa contaria o gasto duas vezes e inflaria o mês inteiro.

**PIX** é forma de pagamento, não categoria. Categorize pelo que foi comprado.
"pix 80 pro mercado" é Mercado. Se for transferência para pessoa sem
contrapartida (ajudar alguém, dividir conta), use `Família > Ajuda familiar` ou
`Outros`, e registre a pessoa na descrição.

**Investimento** é dinheiro que continua sendo dele — não é gasto. Registre
como transferência para a conta de investimento, se ela existir; senão, como
`Investimentos > Aporte`.

**Empréstimo que ele fez a alguém** não é despesa (ele espera receber de
volta). Use `Outros` com a tag `emprestimo` e deixe claro na descrição.

**Saque em dinheiro** é transferência da conta para `Carteira`, não despesa.
O gasto vem depois, quando o dinheiro for usado.

## Criando categoria nova

Só quando algo recorrente não encaixar em nada:

    fin.ts categoria add --nome "Doações" --tipo despesa --emoji 🤝
    fin.ts categoria add --nome "Uber Eats" --pai Alimentação

Não crie categoria para um gasto único — use `Outros` e uma boa descrição.
Árvore inflada é pior que categoria imprecisa.
