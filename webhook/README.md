# Webhook Mercado Pago — entrega automática dos PDFs

Quando alguém paga no link do Mercado Pago, o MP avisa este script, que confere
o pagamento na API do MP, descobre qual produto foi comprado **pelo valor pago**
e manda o PDF por e-mail. Tudo grátis, sem servidor.

```
comprador paga  →  Mercado Pago chama o webhook  →  Apps Script confirma na API do MP
                →  identifica o produto pelo valor  →  envia o PDF por e-mail
                →  registra a venda na planilha
```

> ⚠️ **Este repositório é público.** Nenhum token entra em arquivo. Tudo fica nas
> Propriedades do Script, que só você enxerga.

---

## Antes de começar

Tenha em mãos:

- Os **3 PDFs no Google Drive** (dossiê, fake news, combo)
- Uma conta Mercado Pago com o link de pagamento `link.mercadopago.com.br/studioyami`

---

## Passo 1 — Criar o projeto no Apps Script

1. Abra <https://script.google.com> → **Novo projeto**
2. Renomeie para `eleicoes-2026-webhook`
3. Apague o conteúdo do `Código.gs` e cole o conteúdo de [`Codigo.gs`](Codigo.gs)
4. Salve (Ctrl+S)

---

## Passo 2 — Pegar o ID de cada PDF no Drive

Abra cada PDF no Drive → **Compartilhar → Copiar link**. O link tem esta cara:

```
https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing
                               └────────── esse pedaço é o ID ──────────┘
```

Guarde os 3 IDs. **Não** precisa deixar o arquivo público — o script lê como você.

---

## Passo 3 — Gerar o token secreto do webhook

Esse token é o que impede qualquer pessoa de chamar sua URL e disparar entregas
falsas. Gere um no PowerShell:

```bash
powershell -Command "[Convert]::ToBase64String((1..32|%{Get-Random -Max 256})) -replace '[^a-zA-Z0-9]',''"
```

Copie o resultado. Ele **não** vai para nenhum arquivo do repositório.

---

## Passo 4 — Preencher as Propriedades do Script

No Apps Script: **⚙ Configurações do projeto → Propriedades do script → Adicionar propriedade**.

| Propriedade | Valor | Obrigatória |
|---|---|---|
| `MP_ACCESS_TOKEN` | Access token de **produção** do Mercado Pago (passo 5) | sim |
| `WEBHOOK_TOKEN` | O token que você gerou no passo 3 | sim |
| `EMAIL_DONO` | `yanstutzmatt@gmail.com` — recebe alertas e é o Responder-para | sim |
| `DRIVE_ID_DOSSIE` | ID do PDF do dossiê (R$ 14,90) | sim |
| `DRIVE_ID_FAKENEWS` | ID do PDF do guia antifake (R$ 12,90) | sim |
| `DRIVE_ID_COMBO` | ID do PDF do combo (R$ 19,90) | sim |
| `PLANILHA_ID` | ID de uma planilha em branco para registrar as vendas | não |
| `REMETENTE_NOME` | Nome que aparece como remetente (padrão: `Guias Eleicoes 2026`) | não |

---

## Passo 5 — Pegar o access token do Mercado Pago

1. Entre em <https://www.mercadopago.com.br/developers/panel>
2. **Suas integrações → Criar aplicação** (ou abra uma já existente)
   - Nome: `Guias Eleicoes 2026`
   - Produto: **Pagamentos online**
3. Dentro da aplicação → **Credenciais de produção**
4. Copie o **Access token** e cole na propriedade `MP_ACCESS_TOKEN`

> Esse token move dinheiro na sua conta. Cole direto no Apps Script — nunca em
> chat, e-mail ou arquivo de código.

---

## Passo 6 — Publicar o webhook

No Apps Script: **Implantar → Nova implantação → ⚙ → App da Web**

| Campo | Valor |
|---|---|
| Descrição | `webhook mercado pago` |
| Executar como | **Eu** (`yanstutzmatt@gmail.com`) |
| Quem pode acessar | **Qualquer pessoa** |

Clique **Implantar** e autorize as permissões (vai aparecer um aviso de "app não
verificado" — é o seu próprio script: *Avançado → Acessar eleicoes-2026-webhook*).

Copie a **URL do app da Web**:

```
https://script.google.com/macros/s/AKfycb.../exec
```

Sua URL de notificação é essa **com o token no final**:

```
https://script.google.com/macros/s/AKfycb.../exec?token=SEU_TOKEN_DO_PASSO_3
```

---

## Passo 7 — Apontar o Mercado Pago para o webhook

No painel do MP → sua aplicação → **Webhooks → Configurar notificações**:

1. Cole a URL completa (com `?token=...`) no campo **URL de produção**
2. Em **Eventos**, marque apenas **Pagamentos** (`payment`)
3. Salve

> O MP mostra um campo de "assinatura secreta". Ele **não** é usado aqui: o Apps
> Script não dá acesso aos cabeçalhos HTTP, então a validação de `x-signature` é
> impossível nessa plataforma. O `?token=` do passo 3 cumpre o mesmo papel —
> quem não tem o token recebe `forbidden`.

---

## Passo 8 — Testar

**a) Configuração.** No editor do Apps Script, selecione a função
`testarConfiguracao` e clique **Executar**. O log deve mostrar `OK` em todas as
linhas, incluindo o nome e o tamanho dos 3 PDFs e o token do MP válido.

**b) Venda real.** Abra o link de pagamento, pague **R$ 12,90** (o mais barato)
com outra conta ou cartão. Em segundos você deve receber o PDF por e-mail.
O dinheiro volta pra você, então o custo é só a taxa do MP.

**c) Se não chegou.** No Apps Script → **Execuções**: cada chamada do webhook
aparece ali com o log. No painel do MP → Webhooks, há o histórico de entregas
com o código de resposta.

---

## Manutenção

**Uma entrega falhou.** Pegue o ID do pagamento no painel do MP e, no editor do
Apps Script, rode:

```javascript
reenviarPagamento('123456789')
```

**Mudou o preço.** Altere o valor em dois lugares: o objeto `CATALOGO` no
`Codigo.gs` **e** o texto da landing page correspondente. Se ficarem diferentes,
o comprador paga um valor que o script não reconhece e a entrega cai no manual.

**Mudou o `Codigo.gs`.** Salvar não basta: **Implantar → Gerenciar implantações
→ ✏ → Versão: Nova versão → Implantar**. A URL continua a mesma.

---

## Limites e pontos frágeis

- **O valor identifica o produto.** É a consequência do link de valor livre.
  Se o comprador digitar R$ 15,00 em vez de R$ 14,90, o script não adivinha:
  registra como `manual` e te manda um e-mail para resolver na mão.
  *Para eliminar isso:* crie 3 links de **preço fixo** no painel do MP, um por
  produto, e troque os `href` das landing pages. O código continua funcionando
  igual, e o valor passa a estar sempre certo.
- **100 e-mails por dia** é o limite de conta Gmail comum. Acima disso, a
  entrega para até o dia seguinte.
- **Anexo de até 25 MB.** PDFs maiores precisam virar link em vez de anexo.
- **E-mail do pagador.** Vem do cadastro Mercado Pago dele, não de um formulário
  seu. Em geral funciona; quando o MP não devolve, você é avisado por e-mail.
