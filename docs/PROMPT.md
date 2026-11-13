# Super prompt — LinkSpace

Prompt pronto para colar em um agente de código (Arena, Claude Code, Cursor, Codex,
v0, Lovable etc.) para gerar o app descrito em [`ARQUITETURA.md`](./ARQUITETURA.md).

**Como usar**

1. Anexe o arquivo `bookmarks-2026-11-13.json` (ou outro backup) na conversa.
2. Copie **todo** o bloco "PROMPT" abaixo (do `## PAPEL` até o fim).
3. Se a ferramenta tiver limite de contexto, use o **Prompt curto** (seção 2) e depois
   cole o **Prompt de continuação** (seção 3) pedindo cada arquivo.
4. Depois de gerar, rode o app com `python3 -m http.server 8000` e execute o
   `schema.sql` no Supabase SQL Editor.

---

## 1. PROMPT (completo)

````text
## PAPEL

Você é um engenheiro front-end sênior + especialista em Supabase/Postgres, com olho de
designer de produto. Sua tarefa é ENTREGAR UM APP COMPLETO E FUNCIONAL, não um esboço.

## MISSÃO

Construir o "LinkSpace": um organizador de links pessoais (favoritos) em HTML, CSS e
JavaScript puros (sem build, sem framework), com Supabase como banco, que:

1. importa um JSON de bookmarks de navegador de forma IDEMPOTENTE (ignora links que já
   existem, adiciona os novos, agrupa por categoria);
2. exporta links (todos ou uma seleção escolhida) em JSON, HTML de navegador e CSV;
3. exibe os links em cards agrupados por categoria, com busca central no topo;
4. tem "modo organizar" que revela botões de editar e excluir em cada card + botão
   "Novo Link";
5. tem alternância de tema claro/escuro persistida;
6. tem um modal "Anotações" com editor rico (negrito, itálico, sublinhado) salvo no banco.

## RESTRIÇÕES TÉCNICAS INVIOLÁVEIS

- Entregue EXATAMENTE estes arquivos, completos, sem trechos omitidos e sem "TODO":
  - `index.html`
  - `styles.css`
  - `app.js`
  - `supabase/schema.sql`
  - `README.md` (como rodar, como configurar o Supabase, avisos de segurança)
- NADA de React/Vue/Svelte/Tailwind/jQuery, nada de npm, bundler, TypeScript ou etapa
  de build. HTML + CSS + JS nativos (ES2022, `type="module"`).
- Única dependência externa permitida: `@supabase/supabase-js@2` via CDN ESM
  (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm`), importada
  dinamicamente. Fontes: system-ui. Ícones: SVG inline. Nada de bibliotecas de UI.
- `index.html` deve funcionar servido por qualquer servidor estático (GitHub Pages).
- Sem `eval`, sem HTML de usuário sem escape, sem credencial `service_role`.
- Código comentado em português, identificadores em inglês, textos da interface em pt-BR.
- Sem `console.log` de debug na versão final.

## ARQUITETURA DO app.js (obrigatória, em um único arquivo)

Organize em seções comentadas, nesta ordem, e NÃO deixe a UI chamar o Supabase direto:

1. `CONFIG` — constantes (tabelas, limites, chaves de localStorage, defaults).
2. `util` — `debounce`, `escapeHtml`, `slugify`, `normalizeText` (remove acentos),
   `formatDate`, `hashColor`.
3. `url` — `canonicalizeUrl(url)`, `isValidUrl(url)`, `extractDomain(url)`.
4. `importers` — `detectFormat`, `parseFirefox`, `parseChrome`, `parseGeneric`,
   `buildImportPayload`.
5. `exporters` — `toJson`, `toNetscapeHtml`, `toCsv`, `download`.
6. `api` — cliente Supabase + `selectLinks`, `selectCategories`, `insertLink`,
   `updateLink`, `deleteLink`, `importPayload` (RPC), `getNote`, `saveNote`,
   `testConnection`; com retry exponencial (3 tentativas) e erros traduzidos.
7. `state` — objeto único `state` + `setState(patch)` + `subscribe(render)`.
8. `ui` — `renderAll`, `renderSidebar`, `renderGrid`, `renderCard`, `renderEmpty`,
   `openModal`, `closeModal`, `confirmDialog`, `toast`.
9. `actions` — `loadData`, `importFile`, `exportSelected`, `saveLink`, `deleteLink`,
   `saveNote`, `toggleTheme`, `setQuery`, `setCategory`, `toggleOrganize`.
10. `app` — `init()`, listeners globais, atalhos, tema inicial.

Regra de ouro: `render = f(state)`; toda mutação passa por `actions`.

## IDENTIDADE VISUAL (fidelidade alta à referência)

Fundo da página claro-azulado, cards brancos, bordas suaves, tipografia system-ui,
cantos arredondados, sombras discretas, azul como cor de ação. Use exatamente estes
tokens (o tema escuro sobrescreve os mesmos nomes):

```css
:root{
  --bg:#f4f7f9; --surface:#ffffff; --surface-2:#eef2f6;
  --border:#e2e8f0; --border-strong:#cbd5e1;
  --text:#1e293b; --text-muted:#64748b;
  --primary:#2563eb; --primary-hover:#1d4ed8; --primary-soft:#dbeafe;
  --danger:#dc2626; --success:#16a34a; --warning:#d97706;
  --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-pill:999px;
  --shadow-sm:0 1px 2px rgb(15 23 42/.06);
  --shadow-md:0 4px 16px rgb(15 23 42/.10);
  --shadow-lg:0 24px 64px rgb(15 23 42/.24);
}
[data-theme="dark"]{
  --bg:#0b1220; --surface:#111a2b; --surface-2:#162033;
  --border:#1f2b40; --border-strong:#2b3a54;
  --text:#e6edf7; --text-muted:#94a3b8;
  --primary:#3b82f6; --primary-hover:#60a5fa; --primary-soft:#172b4d;
  --danger:#f87171; --success:#4ade80; --warning:#fbbf24;
}
```

Layout e medidas:
- Barra superior fixa, 64px: `[☰] [busca central] ... [Anotações] [status] [sol/lua] [Organizar]`.
- Área principal: `max-width:1600px; margin:0 auto; padding:24px`.
- Grid: `display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px`.
- Card: `display:grid; grid-template-columns:36px 1fr; gap:12px; padding:14px 16px;
  border:1px solid var(--border); border-radius:var(--radius-md); background:var(--surface)`.
  Título 14px/1.35, 2 linhas com `-webkit-line-clamp`; domínio 12px `--text-muted` com
  ellipsis. Hover: `border-color:var(--border-strong)`, sombra sm, `translateY(-1px)`.
- Favicon 32×32, `border-radius:6px`, `loading="lazy"`; se `favicon_url` for nulo use
  `https://www.google.com/s2/favicons?domain={host}&sz=64` e, no `onerror`, o monograma do
  domínio com cor derivada de hash (nunca quadrado vazio/quebrado).
- Cabeçalho de categoria: nome em MAIÚSCULAS, 12px, `letter-spacing:.06em`,
  `color:var(--text-muted)`, contador à direita, `margin:32px 0 12px`.
- Sidebar: drawer de 300px sobre backdrop `rgba(15,23,42,.45)`, aberta pelo hambúrguer,
  fecha com Esc/backdrop/clique em item. Itens: "Todos", "Favoritos", lista de categorias
  com contador; rodapé com "Importar", "Exportar", "Configurações".
- Busca: pill de 40px, ícone de lupa, `max-width:440px`, centralizada, placeholder
  "Pesquisar...".
- Modais: overlay escuro com blur leve, `radius:16px`, `max-width:720px` (anotações) e
  `480px` (formulário/confirmação), fecham com Esc e clique fora, foco preso.
- Responsivo: 1 coluna < 640px; 2 colunas até 1023px; 3–4 até 1439px; 5 a partir de 1440px.
  No mobile, a busca ocupa linha própria e os botões ficam só com ícone.
- Acessibilidade AA: `:focus-visible` com anel de 2px, `aria-label` em botões de ícone,
  `role="dialog" aria-modal="true"` nos modais, toasts com `aria-live="polite"`,
  alvos de toque ≥ 40px, `prefers-reduced-motion` respeitado.

## MODELO DE DADOS (Supabase) — já definido, apenas implemente

Tabelas: `categories`, `links`, `notes`, `import_logs`, `app_settings`.
Views: `v_categories` (com `link_count`), `v_stats`.
Colunas essenciais:

- `links(id uuid pk, category_id uuid, title text, url text, url_key text UNIQUE,
  domain text, description text, tags text[], favicon_url text, is_favorite bool,
  position int, source text, external_id text, created_at, updated_at, last_opened_at)`
- `categories(id uuid pk, name text, slug text UNIQUE, path text, parent_id uuid,
  color text, position int, created_at, updated_at)`
- `notes(id uuid pk, title text, content_html text, content_text text, link_id uuid,
  is_pinned bool, created_at, updated_at)`
- `import_logs(id, source_file, format, mode, total_found, inserted, skipped_duplicates,
  skipped_invalid, categories_created, report jsonb, created_at)`
- `app_settings(id smallint pk = 1, theme text, sort_mode text, view_mode text, updated_at)`

`supabase/schema.sql` deve conter, nesta ordem: extensões (`pgcrypto`, `pg_trgm`,
`unaccent`), função `slugify`, tabelas com CHECKs, índices (incluindo
`CREATE UNIQUE INDEX ON links(url_key)` e GIN trigram em `lower(title)`), triggers de
`updated_at`, views, a função RPC `import_links(payload jsonb, p_mode text default
'merge', p_source text default 'import.json')` que faz upsert de categorias por `slug`,
insere links com `ON CONFLICT (url_key) DO NOTHING`, conta inseridos/duplicados e grava
em `import_logs`, retornando `{mode,total,inserted,duplicates,invalid,categories_created,
import_log_id}`; RLS habilitado com políticas permissivas para `anon` (modo pessoal),
comentário destacado sobre o risco e um bloco final comentado com o modo multiusuário
(`user_id = auth.uid()`); e os GRANTs necessários.

### Formato do payload da importação (contrato fixo)

```json
{
  "categories": [{"name":"SAUDE","slug":"saude","path":"SAUDE","position":3}],
  "links": [{
    "title":"PEC - Cidadão",
    "url":"https://esus.altolonga.pi.gov.br/",
    "url_key":"https://esus.altolonga.pi.gov.br",
    "domain":"esus.altolonga.pi.gov.br",
    "category_slug":"saude",
    "tags":[],
    "description":null,
    "favicon_url":null,
    "source":"firefox",
    "external_id":"guid-do-navegador",
    "created_at":"2026-08-01T12:00:00.000Z"
  }]
}
```

Na importação chame **somente**:
`supabase.rpc('import_links', { payload, p_mode, p_source: file.name })`.

## IMPORTAÇÃO — REGRAS OBRIGATÓRIAS

Formatos aceitos (detectar automaticamente e informar na prévia):
1. **Firefox** — objeto com `root:"placesRoot"`; nós `text/x-moz-place-container` e
   `text/x-moz-place`. Pastas viram categorias; `guid` → `external_id`;
   `dateAdded` (microssegundos) → `created_at`; `iconUri` `data:` só é mantido se ≤ 4 KB,
   `fake-favicon-uri:` vira `null`.
2. **Chrome/Edge** — objeto com `roots` (`bookmark_bar`, `other`, `synced`),
   `children[].type:"url"`, `name` → título, `date_added` em microssegundos desde
   1601-01-01 (converter para ISO) e `icon` como data URI (mesma regra do Firefox).
3. **LinkSpace** — `{app:"linkspace", version:1, categories:[], links:[]}` (round-trip).
4. **Genérico** — array de `{title|name, url|uri, category|folder, tags}` ou
   `{categories:[{name, links:[{title,url}]}]}`.

Regras:
- Ignorar pastas padrão do navegador: `Mozilla Firefox`, `Bookmarks Toolbar`,
  `Other Bookmarks`, `unfiled`, `mobile` (vazias) — configurável.
- Links soltos na raiz do menu → categoria `DIVERSOS`; links da barra de ferramentas →
  categoria `BARRA DE FERRAMENTAS`; cada pasta com ≥ 1 link → categoria com o nome da pasta.
- Ignorar itens sem `uri` ou com esquema diferente de http/https, contando em `invalid`.
- Título vazio → usar o domínio.
- A prévia deve mostrar: formato detectado, total lido, novos, duplicados no arquivo,
  duplicados no banco, inválidos e categorias que serão criadas. Só então habilitar
  "Importar". Ao final, exibir relatório real retornado pelo servidor.
- Modos: `merge` (padrão) e `replace` (apaga tudo; exigir digitar `APAGAR`).
- Limites: arquivo ≤ 5 MB; > 1000 links → lotes de 500 somando relatórios.
- Reimportar o mesmo arquivo deve resultar em `inserted = 0`.

## CANONICALIZAÇÃO DE URL (url_key) — implemente exatamente

`canonicalizeUrl(url)`:
1. `trim`, remover espaços internos e quebras de linha;
2. decodificar apenas caracteres não reservados (`%7E` → `~`);
3. `scheme` e `host` em minúsculas; remover `www.`;
4. remover porta padrão (`:80` em http, `:443` em https);
5. colapsar barras duplicadas no caminho; remover `/` final (exceto raiz);
6. remover parâmetros de rastreio: `utm_*`, `gclid`, `gbraid`, `wbraid`, `fbclid`,
   `msclkid`, `yclid`, `mc_cid`, `mc_eid`, `igshid`, `si`, `spm`, `_hsenc`, `_hsmi`;
7. ordenar os parâmetros restantes (`?b=2&a=1` → `?a=1&b=2`);
8. remover o fragmento `#...` (configurável em `CONFIG.keepHash = false`);
9. tratar `http` e `https` como iguais (usar `https` no `url_key`).

A URL original (`url`) NUNCA é alterada por esse processo. Ao salvar manualmente uma URL
sem esquema, prefixar `https://` e validar com `new URL()`.

## TELA A TELA — COMPORTAMENTO ESPERADO

### 1. Cabeçalho
- Hambúrguer abre/fecha a sidebar.
- Busca central com debounce de 200 ms, filtra enquanto digita, mostra contador de
  resultados e botão "limpar" (X). Atalhos: `/` e `Ctrl/⌘+K` focam; `Esc` limpa.
- "Anotações" abre o modal de notas.
- Indicador de conexão: `Conectando…` / oculto quando online / `Erro ao conectar`
  (vermelho, clicável, tenta reconectar e mostra o motivo em tooltip).
- Botão de tema alterna claro/escuro (ícone lua quando claro, sol quando escuro,
  `aria-label` correto) e persiste em `localStorage` + `app_settings.theme`.
  Aplique o tema em `<script>` inline no `<head>` para não haver flash.
- "Organizar" alterna o modo de organização; quando ativo, fica com fundo azul
  (`--primary`) e aparece o botão "Novo Link" à sua esquerda.

### 2. Sidebar (drawer)
- "Todos" (ativo por padrão), "Favoritos" e uma entrada por categoria com contador.
- Clicar filtra o grid e marca o item ativo.
- Rodapé: "Importar", "Exportar", "Configurações" (abre o modal de conexão do Supabase
  e permite trocar a chave/URL, testar conexão e mostra o total de links/categorias).
- Fecha ao selecionar uma categoria no mobile.

### 3. Grid
- Com "Todos" selecionado, agrupe os links por categoria em blocos com cabeçalho
  (nome em caixa alta + contador), em ordem alfabética de categoria.
- Com uma categoria selecionada, mostre apenas o bloco dela.
- Ordem dentro do grupo: mais recentes primeiro (`created_at desc`).
- Se não houver links, estado vazio com botões "Importar JSON" e "Novo Link".
- Se a busca não retornar nada, `Nenhum resultado para “termo”` + "Limpar busca".

### 4. Modo organizar
- Cada card exibe dois botões no canto superior direito: lápis (`aria-label="Editar link"`)
  e lixeira (`aria-label="Excluir link"`), sempre visíveis (não dependa de hover em touch).
- Clique no card abre o link em nova aba (`target="_blank" rel="noopener noreferrer"`),
  exceto quando o clique for nos botões de ação.
- Editar: modal com Título*, URL*, Categoria (select + opção "Nova categoria…"),
  Descrição, Tags (input separado por vírgula) e switch "Favorito". Valide URL,
  avise se já existir outro link com a mesma `url_key`, salve e atualize o card com toast
  "Link salvo".
- Novo Link: mesmo modal, vazio, com a categoria atual pré-selecionada.
- Excluir: diálogo de confirmação com o título do link; remove com atualização otimista,
  rollback + toast de erro se falhar; em caso de sucesso, toast "Link excluído" com
  "Desfazer" (desfazer = reinserir o registro).

### 5. Modal Anotações
- Título "Anotações", botões de formatação B / I / U (funcionam em `contenteditable`,
  com estado ativo refletindo a seleção), área de texto grande (mín. 380px de altura,
  fundo `--surface-2`, borda, `padding:16px`), rodapé com "Cancelar" e "Salvar Anotações".
- Carrega a nota mais recente de `notes` (ou cria uma vazia na primeira gravação).
- Autosave: 1,5 s após a última alteração e ao fechar o modal; mostre
  "Alterações não salvas…" / "Salvo às HH:MM".
- "Cancelar" descarta o que foi digitado desde a abertura (restaura o snapshot).
- Persistir `content_html` e também `content_text` (texto puro) para busca futura.
- Sanitizar o HTML antes de renderizar: allowlist de `b,strong,i,em,u,p,br,div,ul,ol,li,
  a[href],span`; remover `<script>`, atributos `on*` e `javascript:`.

### 6. Modal Importar
- Dropzone (arrastar e soltar ou clicar) aceitando `.json`; valide extensão e tamanho.
- Após escolher o arquivo: resumo da prévia (ver regras de importação), seletor de modo
  (Mesclar / Substituir tudo), botão "Importar" e barra de progresso.
- Ao final: relatório com `inseridos`, `duplicados ignorados`, `inválidos`,
  `categorias criadas`; botão "Concluir" (recarrega o grid) e link "Exportar relatório".
- Erros claros: JSON inválido, formato não reconhecido, arquivo grande, falha de rede.

### 7. Modal Exportar
- Busca interna, checkbox "Selecionar todos", checkbox tri-estado por categoria,
  contador `X de N selecionados`, formato (JSON / HTML / CSV) e lista dos links.
- Botão `Exportar N links` desabilitado com 0 selecionados.
- JSON no formato LinkSpace (round-trip), HTML no padrão Netscape Bookmark File (com
  `ADD_DATE` em segundos), CSV com `;` e BOM UTF-8.
- Nome do arquivo: `linkspace-{todos|selecao|slug}-AAAA-MM-DD.ext`.
- Baixar com `Blob` + `URL.createObjectURL`, revogando a URL em seguida.

### 8. Configuração / conexão
- Se não houver `SUPABASE_URL`/`SUPABASE_ANON_KEY` em `CONFIG` nem em `localStorage`,
  abra automaticamente o modal "Conectar ao Supabase" com: URL do projeto, chave anon
  (mascarada, com botão mostrar), botão "Testar conexão" e instruções curtas
  (rodar `supabase/schema.sql`, caminho em Project Settings → API).
- Persistir em `localStorage` (`ls.supabase.url`, `ls.supabase.key`).
- Erros traduzidos: 401 → "Chave inválida"; PGRST205/42P01 → "Tabelas não encontradas:
  execute o schema.sql"; rede → "Não foi possível conectar".
- Mostrar aviso de segurança quando o modo pessoal (sem login) estiver ativo.

### 9. Cache e estados
- Guarde `links`, `categories` e `ts` em `localStorage['ls.cache']`; ao abrir, renderize
  o cache imediatamente e revalide em segundo plano.
- Skeletons no primeiro carregamento; nada de tela branca.
- Toasts para sucesso/erro/info, canto inferior direito, 4 s, `aria-live="polite"`.
- Toda ação destrutiva pede confirmação; toda ação de escrita desabilita o botão enquanto
  está em andamento (evita duplo clique).

## EXPORTAÇÃO — DETALHES

- `toJson(links, categories)` → `{app:"linkspace", version:1, exported_at, count,
  categories:[{name,slug,path}], links:[{title,url,url_key,domain,category_slug,tags,created_at}]}`.
- `toNetscapeHtml(links)` → documento com `<!DOCTYPE NETSCAPE-Bookmark-file-1>`,
  `<META ... charset=UTF-8>`, agrupamento por categoria em `<H3><DL>`, `ADD_DATE` em
  segundos e escape de `& < > "`.
- `toCsv(links)` → BOM + cabeçalho `titulo;url;categoria;dominio;tags;descricao;favorito;criado_em`,
  campos com `"` duplicado quando contiverem `;`, `"` ou quebra de linha.
- Exportar exatamente os itens selecionados, na ordem exibida.

## ERROS, LIMITES E RESILIÊNCIA

- Retry exponencial (300/900/2700 ms) apenas em falhas de rede e 5xx.
- Nunca perder o que o usuário digitou: se salvar falhar, mantenha o modal aberto com os
  dados e mostre a mensagem.
- Importação é atômica: se o RPC falhar, nada é gravado (mostre o erro do servidor).
- Deixe `CONFIG` no topo do `app.js` com: `MAX_FILE_MB: 5`, `MAX_LINKS: 5000`,
  `BATCH_SIZE: 500`, `PAGE_SIZE: 100`, `KEEP_HASH: false`, `DEDUPE_HTTP: true`,
  `TRACKING_PARAMS: [...]`, `STORE_INLINE_ICONS: false`.

## ACESSIBILIDADE E PERFORMANCE (não negociáveis)

- Contraste AA nos dois temas; foco visível; navegação por teclado em cards, modais e
  checklist de exportação; foco preso e restaurado nos modais; `Esc` fecha.
- `loading="lazy"` e `decoding="async"` nas imagens; `onerror` para o monograma.
- Filtro/busca em < 50 ms para 1000 links; render com `DocumentFragment` e delegação de
  eventos; se houver > 300 links, renderizar 100 por vez com "Carregar mais".

## CRITÉRIOS DE ACEITE (verifique um por um antes de responder)

1. Importar o `bookmarks-2026-11-13.json` (175 links, 12 pastas) cria ~11 categorias e
   ~174 links; a URL repetida gera 1 link e 1 duplicado no relatório.
2. Reimportar o MESMO arquivo resulta em `inserted: 0` e `duplicates: 175`.
3. Importar 3 links novos + 2 existentes insere exatamente 3.
4. Sidebar filtra por categoria e mostra contagem correta; "Todos" restaura.
5. Busca "sisa" acha SISAB/SISAIH; "saude" acha "SAÚDE"; `Esc` limpa.
6. "Organizar" revela editar/excluir e "Novo Link"; editar reflete no banco após reload.
7. Excluir pede confirmação, remove do banco e permite desfazer.
8. Exportar todos em JSON e reimportar não cria duplicados (round-trip).
9. Exportar 3 selecionados gera arquivo com exatamente 3 links; HTML abre no Firefox.
10. Anotações com negrito persistem após reload e aparecem em outra aba.
11. Tema persiste e não há flash de tema no reload.
12. Layout sem overflow em 360, 768, 1280 e 1920 px; modais usáveis no celular.
13. Nenhum erro no console ao navegar, buscar, organizar, importar e exportar.
14. `schema.sql` executa do zero sem erro em um projeto Supabase novo.

## PROIBIDO

- Entregar código parcial, pseudocódigo, "implemente aqui", `alert()`/`confirm()`/
  `prompt()` nativos em vez de UI própria, ou placeholders de imagem.
- Usar `localStorage` como banco de links (o Supabase é a fonte de verdade; o cache é
  apenas otimização).
- Deduplicar por título (URLs diferentes podem ter o mesmo título) — a chave é `url_key`.
- Alterar a URL original do usuário durante a importação.
- Deixar a chave `anon` aparecendo em logs ou em URL.

## FORMATO DA RESPOSTA

1. Um resumo de 5–10 linhas do que foi construído e das decisões tomadas.
2. Os arquivos completos, um por um, em blocos de código com o caminho no título
   (`index.html`, `styles.css`, `app.js`, `supabase/schema.sql`, `README.md`).
3. Passo a passo de instalação (Supabase + servidor local/deploy).
4. Checklist final marcando cada critério de aceite com ✅.

Comece agora e entregue tudo de uma vez, sem pedir confirmação.
````

---

## 2. Prompt curto (para ferramentas com pouco contexto)

````text
Crie um app estático (apenas index.html, styles.css, app.js + supabase/schema.sql, sem
build nem frameworks, supabase-js v2 via CDN ESM) chamado LinkSpace: organizador de
links pessoais com Supabase.

Requisitos:
- Cards agrupados por categoria (nome da categoria em cabeçalho), grid responsivo
  (1/2/3-4/5 colunas), favicon 32px com fallback de monograma, título 2 linhas e domínio.
- Header com hambúrguer (drawer lateral com Todos, Favoritos e categorias com contador,
  e Importar/Exportar/Configurações), busca central (debounce 200ms, insensível a
  acentos), botão Anotações, indicador de conexão, toggle claro/escuro e botão Organizar.
- Modo organizar revela nos cards botões de editar (lápis) e excluir (lixeira) e mostra
  "Novo Link" no header.
- Importação de JSON de bookmarks (Firefox places / Chrome / formato próprio / genérico)
  IDEMPOTENTE: URL canônica `url_key` com índice UNIQUE; pastas viram categorias; prévia
  com novos/duplicados/inválidos; RPC `import_links(payload, mode, source)` transacional
  que retorna relatório; reimportar o mesmo arquivo deve inserir 0.
- Exportação com seleção (checkbox por link, selecionar todos, tri-estado por categoria)
  em JSON (round-trip), HTML Netscape (importável no navegador) e CSV com BOM.
- Modal Anotações com contenteditable + B/I/U, autosave 1,5s e persistência na tabela
  `notes` (content_html + content_text, HTML sanitizado).
- Tema claro/escuro por `data-theme` + tokens CSS, persistido em localStorage e no banco,
  aplicado antes do primeiro paint.
- Tabelas: categories, links, notes, import_logs, app_settings; views v_categories,
  v_stats; índices (unique url_key, trigram em title); triggers updated_at; RLS ligado
  com políticas para `anon` (modo pessoal) e bloco comentado para multiusuário.
- Estados de loading (skeleton), vazio, erro; toasts; confirmação de exclusão; retry de
  rede; acessibilidade AA; pt-BR na interface; código comentado.

Entregue os arquivos completos e um checklist de aceite no final.
````

---

## 3. Prompt de continuação (para pedir arquivo por arquivo)

````text
Continue o projeto LinkSpace seguindo exatamente a arquitetura combinada. Gere agora
apenas o arquivo `app.js` COMPLETO, em um único módulo, com as seções numeradas
CONFIG, util, url, importers, exporters, api, state, ui, actions e app.

Requisitos específicos desta entrega:
- `canonicalizeUrl` exatamente com as 9 regras (minúsculas em host, sem www, sem porta
  padrão, sem barra final, sem utm_*, query ordenada, sem hash, http≡https, decode de
  não reservados).
- `detectFormat` + `parseFirefox` / `parseChrome` / `parseGeneric` + `buildImportPayload`
  (pastas padrão ignoradas; links de raiz → DIVERSOS; toolbar → BARRA DE FERRAMENTAS).
- `supabase.rpc('import_links', { payload, p_mode, p_source })` como única chamada de
  importação, com lotes de 500 acima de 1000 links e soma dos relatórios.
- `render = f(state)` com delegação de eventos; nenhuma chamada direta ao Supabase na UI.
- Exportação JSON/HTML Netscape/CSV com Blob e revogação de URL.
- Autosave das notas com debounce 800–1500 ms e sanitização por allowlist.
- Retry exponencial em falhas de rede; erros traduzidos para pt-BR; sem console.log.

Não repita o HTML nem o CSS; assuma que já existem com os ids/classes descritos.
````
