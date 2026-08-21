/**
 * Webhook Mercado Pago -> entrega automatica por e-mail.
 * Projeto: eleicoes-2026 (yanstutz33.github.io/eleicoes-2026)
 *
 * Fluxo: comprador paga num dos 3 links de preco fixo -> MP chama este
 * endpoint -> consultamos o pagamento na API do MP -> identificamos o produto
 * pelo valor pago -> enviamos o PDF por e-mail e registramos na planilha.
 *
 * NENHUMA credencial fica neste arquivo. Tudo vem de Propriedades do Script
 * (Configuracoes do projeto > Propriedades do script). Ver README.md.
 */

// ---------------------------------------------------------------------------
// CATALOGO: valor pago (BRL) -> produto entregue
//
// Cada chave e o preco do link de pagamento correspondente no Mercado Pago.
// Para mudar um preco, altere em TRES lugares: o link no painel do MP, a chave
// aqui e o texto da landing page. Se o MP e este catalogo divergirem, a venda
// cai na entrega manual.
//
// Os precos precisam continuar diferentes entre si: e o valor que distingue um
// produto do outro.
// ---------------------------------------------------------------------------
var CATALOGO = {
  '14.90': { // https://mpago.la/2vX6BMu
    nome: 'Dossie: Erros e Acertos dos Candidatos 2026',
    propArquivo: 'DRIVE_ID_DOSSIE',
    nomeArquivo: 'Dossie-Erros-e-Acertos-dos-Candidatos-2026.pdf'
  },
  '12.90': { // https://mpago.la/24cVvT4
    nome: 'Guia: Como Identificar Fake News e Midia Suja',
    propArquivo: 'DRIVE_ID_FAKENEWS',
    nomeArquivo: 'Guia-Como-Identificar-Fake-News-2026.pdf'
  },
  '19.90': { // https://mpago.la/2ScG6hb
    nome: 'Combo: Dossie dos Candidatos + Guia Antifake',
    propArquivo: 'DRIVE_ID_COMBO',
    nomeArquivo: 'Combo-Guias-Eleicoes-2026.pdf'
  }
};

var MP_API = 'https://api.mercadopago.com/v1/payments/';

// ---------------------------------------------------------------------------
// ENTRADA DO WEBHOOK
// ---------------------------------------------------------------------------

/**
 * O Mercado Pago faz POST aqui a cada evento de pagamento.
 * Respondemos 200 em praticamente todos os casos: um erro devolvido faz o MP
 * reenviar a notificacao por horas. Falhas reais viram e-mail de alerta.
 */
function doPost(e) {
  try {
    if (!autorizado_(e)) {
      log_('AUTH', 'Requisicao sem token valido descartada');
      return texto_('forbidden');
    }

    var pagamentoId = extrairPagamentoId_(e);
    if (!pagamentoId) return texto_('ignorado: evento sem id de pagamento');

    processarPagamento_(String(pagamentoId));
    return texto_('ok');

  } catch (err) {
    // Nunca deixamos a excecao vazar: avisamos e devolvemos 200.
    log_('ERRO', 'doPost: ' + (err && err.stack ? err.stack : err));
    alertarDono_('Falha no webhook', String(err && err.stack ? err.stack : err));
    return texto_('ok');
  }
}

/** Permite testar a URL no navegador sem expor nada. */
function doGet(e) {
  if (!autorizado_(e)) return texto_('forbidden');
  return texto_('webhook eleicoes-2026 ativo');
}

// ---------------------------------------------------------------------------
// SEGURANCA
// ---------------------------------------------------------------------------

/**
 * Apps Script nao expoe headers HTTP, entao a assinatura x-signature do MP
 * nao pode ser verificada aqui. Usamos a alternativa suportada: um segredo
 * na query string da URL de notificacao (?token=...), comparado em tempo
 * constante para nao vazar informacao por timing.
 */
function autorizado_(e) {
  var esperado = prop_('WEBHOOK_TOKEN');
  var recebido = (e && e.parameter && e.parameter.token) || '';
  if (!esperado) throw new Error('WEBHOOK_TOKEN nao configurado nas Propriedades do script');
  if (recebido.length !== esperado.length) return false;
  var diff = 0;
  for (var i = 0; i < esperado.length; i++) {
    diff |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PROCESSAMENTO
// ---------------------------------------------------------------------------

/** O MP manda o id em formatos diferentes conforme a versao/tipo do evento. */
function extrairPagamentoId_(e) {
  var p = (e && e.parameter) || {};
  var tipo = p.type || p.topic || '';

  var corpo = {};
  if (e && e.postData && e.postData.contents) {
    try { corpo = JSON.parse(e.postData.contents); } catch (err) { corpo = {}; }
  }
  var tipoCorpo = corpo.type || corpo.topic || '';

  // So nos interessa evento de pagamento. merchant_order etc. sao ignorados.
  var ehPagamento = tipo === 'payment' || tipoCorpo === 'payment';
  if (!ehPagamento) return null;

  return (corpo.data && corpo.data.id) || p['data.id'] || p.id || null;
}

function processarPagamento_(pagamentoId) {
  // Idempotencia: o MP reenvia a mesma notificacao varias vezes (payment.created,
  // payment.updated, mais retentativas). Sem o lock, o comprador recebe o PDF
  // duplicado. O lock serializa; a marca na propriedade impede o reenvio.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    log_('LOCK', 'Nao consegui o lock para ' + pagamentoId);
    return;
  }

  try {
    if (jaEntregue_(pagamentoId)) {
      log_('DUPLICADO', 'Pagamento ' + pagamentoId + ' ja entregue, ignorando');
      return;
    }

    var pgto = consultarPagamento_(pagamentoId);
    if (!pgto) return;

    if (pgto.status !== 'approved') {
      log_('PENDENTE', 'Pagamento ' + pagamentoId + ' com status ' + pgto.status + ', nada a entregar');
      return;
    }

    var valor = normalizarValor_(pgto.transaction_amount);
    var email = emailDoComprador_(pgto);
    var produto = CATALOGO[valor];

    if (!produto) {
      // Com precos fixos isso so acontece se o preco mudou no painel do MP e nao
      // aqui. Nao adivinhamos o produto: registramos e chamamos o dono.
      registrar_(pagamentoId, email, valor, 'VALOR NAO RECONHECIDO', 'manual');
      alertarDono_(
        'Pagamento de R$ ' + valor + ' sem produto correspondente',
        'Pagamento: ' + pagamentoId + '\n' +
        'Comprador: ' + (email || '(sem e-mail)') + '\n' +
        'Valor pago: R$ ' + valor + '\n\n' +
        'Nenhum produto do catalogo bate com esse valor. Entregue manualmente ' +
        'ou devolva o pagamento pelo painel do Mercado Pago.'
      );
      return;
    }

    if (!email) {
      registrar_(pagamentoId, '', valor, produto.nome, 'sem e-mail');
      alertarDono_(
        'Pagamento aprovado sem e-mail do comprador',
        'Pagamento: ' + pagamentoId + '\nProduto: ' + produto.nome +
        '\n\nO Mercado Pago nao devolveu e-mail do pagador. Entregue manualmente.'
      );
      return;
    }

    enviarProduto_(email, produto);
    marcarEntregue_(pagamentoId);
    registrar_(pagamentoId, email, valor, produto.nome, 'entregue');
    log_('ENTREGUE', produto.nome + ' -> ' + email);

  } finally {
    lock.releaseLock();
  }
}

/** Consulta a API do MP. Sem isso, qualquer um poderia forjar um "pagamento". */
function consultarPagamento_(pagamentoId) {
  var resp = UrlFetchApp.fetch(MP_API + encodeURIComponent(pagamentoId), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + prop_('MP_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });

  var codigo = resp.getResponseCode();
  if (codigo === 404) {
    log_('404', 'Pagamento ' + pagamentoId + ' nao encontrado na conta');
    return null;
  }
  if (codigo !== 200) {
    throw new Error('API do MP respondeu ' + codigo + ': ' + resp.getContentText().slice(0, 500));
  }
  return JSON.parse(resp.getContentText());
}

function emailDoComprador_(pgto) {
  var payer = pgto.payer || {};
  var email = payer.email || '';
  if (!email && pgto.additional_info && pgto.additional_info.payer) {
    email = pgto.additional_info.payer.email || '';
  }
  return String(email).trim();
}

/** Normaliza 14.9 / 14.90 / "14,90" para a chave "14.90" do catalogo. */
function normalizarValor_(valor) {
  return Number(String(valor).replace(',', '.')).toFixed(2);
}

// ---------------------------------------------------------------------------
// ENTREGA
// ---------------------------------------------------------------------------

function enviarProduto_(email, produto) {
  var driveId = prop_(produto.propArquivo);
  var blob = DriveApp.getFileById(driveId).getBlob().setName(produto.nomeArquivo);

  MailApp.sendEmail({
    to: email,
    name: prop_('REMETENTE_NOME', true) || 'Guias Eleicoes 2026',
    replyTo: prop_('EMAIL_DONO'),
    subject: 'Seu material chegou: ' + produto.nome,
    body: corpoTexto_(produto),
    htmlBody: corpoHtml_(produto),
    attachments: [blob]
  });
}

function corpoTexto_(produto) {
  return [
    'Pagamento confirmado. Seu material esta em anexo neste e-mail.',
    '',
    produto.nome,
    '',
    'O arquivo e seu, pode salvar e reler quando quiser. Todas as afirmacoes',
    'do material vem com a fonte oficial indicada (TCU, TSE, Senado Verifica,',
    'Aos Fatos, Agencia Lupa, Comprova).',
    '',
    'Se o anexo nao abrir ou vier algum problema, responda este e-mail.',
    '',
    'https://yanstutz33.github.io/eleicoes-2026/',
    '',
    'Estes materiais tem fins informativos e nao representam apoio a nenhum',
    'candidato ou partido.'
  ].join('\n');
}

function corpoHtml_(produto) {
  return '' +
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;color:#1c2029;line-height:1.6">' +
      '<p style="font-family:monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#9c2b2b;margin:0 0 14px">Pagamento confirmado</p>' +
      '<h2 style="font-family:Georgia,serif;font-size:22px;line-height:1.25;margin:0 0 14px">' + escapar_(produto.nome) + '</h2>' +
      '<p style="margin:0 0 14px">Seu material esta <strong>em anexo</strong> neste e-mail. O arquivo e seu, pode salvar e reler quando quiser.</p>' +
      '<p style="margin:0 0 14px;color:#454a52;font-size:14px">Todas as afirmacoes vem com a fonte oficial indicada: TCU, TSE, Senado Verifica, Aos Fatos, Agencia Lupa e Comprova.</p>' +
      '<p style="margin:0 0 20px;font-size:14px">Se o anexo nao abrir, e so responder este e-mail.</p>' +
      '<hr style="border:none;border-top:1px solid #c9c0a4;margin:0 0 14px">' +
      '<p style="font-size:11px;color:#454a52;margin:0">Estes materiais tem fins informativos e nao representam apoio a nenhum candidato ou partido.<br>' +
      '<a href="https://yanstutz33.github.io/eleicoes-2026/" style="color:#9c2b2b">yanstutz33.github.io/eleicoes-2026</a></p>' +
    '</div>';
}

function escapar_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// ESTADO E REGISTRO
// ---------------------------------------------------------------------------

function jaEntregue_(pagamentoId) {
  return PropertiesService.getScriptProperties().getProperty('pago_' + pagamentoId) !== null;
}

function marcarEntregue_(pagamentoId) {
  PropertiesService.getScriptProperties().setProperty('pago_' + pagamentoId, new Date().toISOString());
}

/** Grava a venda na planilha de controle. Nunca derruba a entrega se falhar. */
function registrar_(pagamentoId, email, valor, produto, situacao) {
  try {
    var id = prop_('PLANILHA_ID', true);
    if (!id) return;
    var aba = SpreadsheetApp.openById(id).getSheets()[0];
    if (aba.getLastRow() === 0) {
      aba.appendRow(['Data', 'Pagamento MP', 'E-mail', 'Valor (R$)', 'Produto', 'Situacao']);
    }
    aba.appendRow([new Date(), pagamentoId, email, valor, produto, situacao]);
  } catch (err) {
    log_('PLANILHA', 'Nao consegui registrar: ' + err);
  }
}

function alertarDono_(assunto, corpo) {
  try {
    var dono = prop_('EMAIL_DONO', true);
    if (dono) MailApp.sendEmail(dono, '[eleicoes-2026] ' + assunto, corpo);
  } catch (err) {
    log_('ALERTA', 'Nao consegui avisar o dono: ' + err);
  }
}

// ---------------------------------------------------------------------------
// UTILITARIOS
// ---------------------------------------------------------------------------

function prop_(chave, opcional) {
  var v = PropertiesService.getScriptProperties().getProperty(chave);
  if (!v && !opcional) throw new Error('Propriedade "' + chave + '" nao configurada. Ver README.md');
  return v;
}

function texto_(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

function log_(tag, msg) {
  console.log('[' + tag + '] ' + msg);
}

// ---------------------------------------------------------------------------
// TESTES MANUAIS (rode pelo editor do Apps Script, nunca pelo webhook)
// ---------------------------------------------------------------------------

/** Confere se todas as propriedades e arquivos do Drive estao acessiveis. */
function testarConfiguracao() {
  ['MP_ACCESS_TOKEN', 'WEBHOOK_TOKEN', 'EMAIL_DONO'].forEach(function (c) {
    prop_(c);
    console.log('OK  propriedade ' + c);
  });

  Object.keys(CATALOGO).forEach(function (valor) {
    var p = CATALOGO[valor];
    var arq = DriveApp.getFileById(prop_(p.propArquivo));
    console.log('OK  R$ ' + valor + ' -> ' + arq.getName() + ' (' + Math.round(arq.getSize() / 1024) + ' KB)');
  });

  var r = UrlFetchApp.fetch('https://api.mercadopago.com/users/me', {
    headers: { Authorization: 'Bearer ' + prop_('MP_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  console.log(r.getResponseCode() === 200
    ? 'OK  token do Mercado Pago valido'
    : 'FALHA no token do MP: ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));

  console.log('Configuracao conferida.');
}

/** Reprocessa um pagamento real pelo ID (use se uma entrega falhou). */
function reenviarPagamento(pagamentoId) {
  if (!pagamentoId) throw new Error('Informe o ID do pagamento do Mercado Pago');
  PropertiesService.getScriptProperties().deleteProperty('pago_' + pagamentoId);
  processarPagamento_(String(pagamentoId));
}
