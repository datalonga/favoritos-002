/* ============================================================================
   LinkSpace — organizador de links (favoritos)
   ----------------------------------------------------------------------------
   Arquivo único, sem build. Seções:
     1. CONFIG      — constantes e limites
     2. util        — helpers puros
     3. url         — validação e canonicalização (dedupe)
     4. importers   — detecção de formato + parsing de bookmarks
     5. exporters   — JSON / HTML (Netscape) / CSV
     6. api         — Supabase + adaptador de demonstração em memória
     7. state       — estado único + store
     8. ui          — renderização (render = f(state))
     9. actions     — casos de uso
    10. app         — bootstrap, eventos, atalhos, tema
   ========================================================================== */

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  // Configuração pública padrão para o site estático. Não coloque chaves secretas aqui.
  // Uma configuração salva pelo usuário neste navegador tem prioridade.
  SUPABASE_URL: 'https://vkjbospwanwyizhnktyy.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Ubt6st1DTVCpM5vGzF02mw_5EnUk81o',
  SUPABASE_CDN: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',

  MAX_FILE_MB: 5,
  MAX_LINKS: 5000,
  BATCH_SIZE: 500,
  PAGE_SIZE: 100,

  KEEP_HASH: false,
  DEDUPE_HTTP: true,
  STORE_INLINE_ICONS: false,

  TRACKING_PARAMS: [
    'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid',
    'mc_cid', 'mc_eid', 'igshid', 'si', 'spm', '_hsenc', '_hsmi'
  ],

  DEFAULT_CATEGORY: 'DIVERSOS',
  TOOLBAR_CATEGORY: 'BARRA DE FERRAMENTAS',
  IGNORED_FOLDERS: [
    'mozilla firefox', 'bookmarks toolbar', 'other bookmarks', 'unfiled',
    'mobile bookmarks', 'barra de favoritos', 'outros favoritos',
    'favoritos do firefox', 'outros marcadores'
  ],

  FAVICON_SERVICE: 'https://www.google.com/s2/favicons?sz=64&domain=',

  STORAGE: {
    url: 'ls.supabase.url',
    key: 'ls.supabase.key',
    theme: 'ls.theme',
    cache: 'ls.cache',
    demo: 'ls.demo'
  },

  TABLES: {
    links: 'links',
    categories: 'categories',
    categoriesView: 'v_categories',
    notes: 'notes',
    settings: 'app_settings'
  }
};

const MESSAGES = {
  offline: 'Não foi possível conectar ao Supabase.',
  noSchema: 'Tabelas não encontradas: execute o schema.sql no Supabase.',
  badKey: 'Chave inválida. Confira a chave anon em Project Settings → API.',
  network: 'Não foi possível conectar. Verifique a URL do projeto e sua internet.',
  duplicate: 'Este link já existe na sua coleção.',
  generic: 'Ocorreu um erro inesperado.'
};

/* ============================== 2. util ============================== */
const util = {
  debounce(fn, wait = 200) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  },

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  },

  /** Remove acentos, normaliza espaços e caixa (usado na busca). */
  normalizeText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  },

  /** Gera slug estável a partir de nome ou caminho de pasta. */
  slugify(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9/]+/g, '-')
      .replace(/[/-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  },

  formatTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '--:--';
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
  },

  hue(value) {
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
  },

  uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  /** Remove tudo que não for texto. */
  stripHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');
    return (template.content.textContent || '').replace(/\u00a0/g, ' ').trim();
  },

  /** Allowlist de HTML para as anotações (B/I/U, listas e links). */
  sanitizeHtml(html) {
    const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'P', 'BR', 'DIV', 'UL', 'OL', 'LI', 'A', 'SPAN']);
    const ALLOWED_ATTRS = { A: ['href', 'title'] };
    const BLOCKED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'IMG']);

    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');

    const clean = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.COMMENT_NODE) {
          child.remove();
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) return;

        if (BLOCKED.has(child.tagName)) {
          child.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(child.tagName)) {
          clean(child);
          child.replaceWith(...Array.from(child.childNodes));
          return;
        }

        Array.from(child.attributes).forEach((attr) => {
          const name = attr.name.toLowerCase();
          const allowed = ALLOWED_ATTRS[child.tagName] || [];
          if (!allowed.includes(name)) {
            child.removeAttribute(attr.name);
            return;
          }
          if (name === 'href' && !/^(https?:|mailto:)/i.test(attr.value.trim())) {
            child.removeAttribute('href');
          }
        });

        if (child.tagName === 'A') {
          if (!child.getAttribute('href')) {
            child.replaceWith(...Array.from(child.childNodes));
            return;
          }
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        clean(child);
      });
    };

    clean(template.content);
    return template.innerHTML;
  },

  /** Cria um Blob e dispara o download. */
  download(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  },

  today() {
    return new Date().toISOString().slice(0, 10);
  }
};

/* ============================== 3. url ============================== */
const urlUtils = {
  withScheme(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    return `https://${raw}`;
  },

  isValid(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return false;
    try {
      const parsed = new URL(this.withScheme(raw));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return Boolean(parsed.hostname) && (parsed.hostname.includes('.') || parsed.hostname === 'localhost');
    } catch {
      return false;
    }
  },

  domain(value) {
    try {
      return new URL(this.withScheme(value)).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  },

  /**
   * URL canônica usada como chave de deduplicação.
   * A URL original do usuário nunca é alterada por esta função.
   */
  canonicalize(value) {
    const raw = String(value ?? '').trim().replace(/[\s\u00a0]+/g, '');
    if (!raw) return '';

    let parsed;
    try {
      parsed = new URL(this.withScheme(raw));
    } catch {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

    // 9) http e https são equivalentes para comparação
    const scheme = CONFIG.DEDUPE_HTTP ? 'https:' : parsed.protocol;

    // 3) host minúsculo, sem www
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);

    // 4) porta padrão removida
    const isDefaultPort =
      (parsed.protocol === 'http:' && (parsed.port === '80' || parsed.port === '')) ||
      (parsed.protocol === 'https:' && (parsed.port === '443' || parsed.port === ''));
    const port = !isDefaultPort && parsed.port ? `:${parsed.port}` : '';

    // 5) barras duplicadas e barra final
    let path = parsed.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    if (!path) path = '/';

    // 2) decodifica apenas caracteres não reservados
    path = path.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(char) ? char : match.toUpperCase();
    });

    // 6) parâmetros de rastreio + 7) ordenação
    const tracking = new Set(CONFIG.TRACKING_PARAMS.map((item) => item.toLowerCase()));
    const params = [];
    parsed.searchParams.forEach((paramValue, paramName) => {
      const key = paramName.toLowerCase();
      if (key.startsWith('utm_') || tracking.has(key)) return;
      params.push([paramName, paramValue]);
    });
    params.sort((a, b) => {
      if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
      return a[0] < b[0] ? -1 : 1;
    });
    const query = params.length
      ? `?${params.map(([key, paramValue]) => `${encodeURIComponent(key)}=${encodeURIComponent(paramValue)}`).join('&')}`
      : '';

    // 8) fragmento
    const hash = CONFIG.KEEP_HASH && parsed.hash ? parsed.hash : '';

    return `${scheme}//${host}${port}${path === '/' ? '' : path}${query}${hash}`;
  }
};

/* ============================== 4. importers ============================== */
const importers = {
  isIgnoredFolder(name) {
    return CONFIG.IGNORED_FOLDERS.includes(util.normalizeText(name));
  },

  detectFormat(json) {
    if (Array.isArray(json)) return 'generic';
    if (!json || typeof json !== 'object') return null;
    if (json.app === 'linkspace' && Array.isArray(json.links)) return 'linkspace';
    if (json.root === 'placesRoot') return 'firefox';
    if (json.roots && typeof json.roots === 'object') return 'chrome';
    if (Array.isArray(json.categories) && Array.isArray(json.links)) return 'linkspace';
    if (Array.isArray(json.categories)) return 'generic';
    if (Array.isArray(json.children)) return 'firefox';
    if (Array.isArray(json.links)) return 'generic';
    return null;
  },

  /** Firefox: pastas (containers) viram categorias; nós texto/x-moz-place são links. */
  parseFirefox(json) {
    const records = [];

    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'text/x-moz-place') {
        records.push({
          title: node.title,
          url: node.uri,
          folderPath: path.join('/'),
          dateAdded: node.dateAdded,
          guid: node.guid,
          iconUri: node.iconUri
        });
        return;
      }

      const isContainer = node.type === 'text/x-moz-place-container' || Array.isArray(node.children);
      if (!isContainer) return;

      let nextPath = path;
      const rootKey = node.root;

      if (rootKey === 'placesRoot') {
        nextPath = [];
      } else if (rootKey === 'toolbarFolder') {
        nextPath = [CONFIG.TOOLBAR_CATEGORY];
      } else if (rootKey === 'bookmarksMenuFolder' || rootKey === 'unfiledBookmarksFolder' || rootKey === 'mobileFolder') {
        nextPath = [];
      } else {
        const name = String(node.title || '').trim();
        if (!name) {
          nextPath = path;
        } else if (this.isIgnoredFolder(name)) {
          nextPath = path;
        } else {
          nextPath = [...path, name];
        }
      }

      (node.children || []).forEach((child) => walk(child, nextPath));
    };

    walk(json, []);
    return records;
  },

  /** Chrome/Edge: raízes bookmark_bar, other e synced. */
  parseChrome(json) {
    const records = [];
    const roots = json.roots || {};

    const walk = (node, path, isRoot) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'url') {
        records.push({
          title: node.name,
          url: node.url,
          folderPath: path.join('/'),
          dateAdded: node.date_added ? Number(node.date_added) / 1000 - 11644473600000 : undefined,
          guid: node.guid || node.id,
          iconUri: node.icon
        });
        return;
      }

      const name = String(node.name || '').trim();
      let nextPath = path;
      if (!isRoot && name) {
        if (!this.isIgnoredFolder(name)) nextPath = [...path, name];
      }
      (node.children || []).forEach((child) => walk(child, nextPath, false));
    };

    if (roots.bookmark_bar) walk(roots.bookmark_bar, [CONFIG.TOOLBAR_CATEGORY], true);
    if (roots.other) walk(roots.other, [], true);
    if (roots.synced) walk(roots.synced, [], true);

    return records;
  },

  /** Formato do próprio app (round-trip). */
  parseLinkspace(json) {
    const categoryBySlug = new Map();
    (json.categories || []).forEach((category) => {
      if (!category) return;
      const slug = category.slug || util.slugify(category.path || category.name);
      if (slug) categoryBySlug.set(slug, category.path || category.name || slug);
    });

    return (json.links || []).map((link) => ({
      title: link.title,
      url: link.url,
      folderPath: categoryBySlug.get(link.category_slug) || link.category || CONFIG.DEFAULT_CATEGORY,
      dateAdded: link.created_at,
      guid: link.external_id,
      iconUri: link.favicon_url,
      tags: link.tags,
      description: link.description,
      source: link.source
    }));
  },

  /** Formato genérico: array de objetos ou { categories: [{ name, links }] }. */
  parseGeneric(json) {
    const records = [];

    const push = (item, folder) => {
      if (!item || typeof item !== 'object') return;
      records.push({
        title: item.title ?? item.name,
        url: item.url ?? item.uri ?? item.link ?? item.href,
        folderPath: folder ?? item.category ?? item.folder ?? item.category_name ?? '',
        dateAdded: item.created_at ?? item.date ?? item.dateAdded,
        guid: item.external_id ?? item.guid,
        iconUri: item.favicon_url ?? item.icon,
        tags: item.tags,
        description: item.description
      });
    };

    if (Array.isArray(json)) {
      json.forEach((item) => push(item, null));
      return records;
    }

    if (Array.isArray(json.categories)) {
      json.categories.forEach((category) => {
        const folder = category.name || category.path || '';
        (category.links || []).forEach((item) => push(item, folder));
      });
      return records;
    }

    if (Array.isArray(json.links)) {
      json.links.forEach((item) => push(item, null));
    }
    return records;
  },

  parseRecords(json, format) {
    if (format === 'firefox') return this.parseFirefox(json);
    if (format === 'chrome') return this.parseChrome(json);
    if (format === 'linkspace') return this.parseLinkspace(json);
    return this.parseGeneric(json);
  },

  normalizeTags(tags) {
    if (!tags) return [];
    const list = Array.isArray(tags) ? tags : String(tags).split(',');
    return Array.from(new Set(
      list
        .map((tag) => String(tag ?? '').trim())
        .filter(Boolean)
        .slice(0, 20)
    ));
  },

  pickIcon(iconUri) {
    const icon = String(iconUri ?? '').trim();
    if (!icon) return null;
    if (icon.startsWith('fake-favicon-uri:')) return null;
    if (icon.startsWith('data:')) {
      return CONFIG.STORE_INLINE_ICONS && icon.length <= 4096 ? icon : null;
    }
    return /^https?:\/\//i.test(icon) ? icon : null;
  },

  normalizeDate(value) {
    if (value === undefined || value === null || value === '') return undefined;
    let date;
    if (typeof value === 'number') {
      // Firefox usa microssegundos; Chrome usa microssegundos desde 1601.
      const asMs = value > 1e15 ? value / 1000 : value;
      date = new Date(asMs);
    } else {
      date = new Date(value);
    }
    if (Number.isNaN(date.getTime()) || date.getFullYear() < 1990 || date.getFullYear() > 2200) {
      return undefined;
    }
    return date.toISOString();
  },

  /**
   * Converte registros crus no payload do RPC import_links,
   * já deduplicado dentro do próprio arquivo.
   */
  buildPayload(records, format) {
    const categories = new Map();
    const links = [];
    const seen = new Set();

    let invalid = 0;
    let duplicatesInFile = 0;

    records.forEach((record) => {
      const rawUrl = String(record.url ?? '');

      if (!rawUrl || !urlUtils.isValid(rawUrl)) {
        invalid += 1;
        return;
      }

      const key = urlUtils.canonicalize(rawUrl);
      if (!key) {
        invalid += 1;
        return;
      }
      if (seen.has(key)) duplicatesInFile += 1;
      seen.add(key);

      const folder = String(record.folderPath || '')
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/') || CONFIG.DEFAULT_CATEGORY;

      const slug = util.slugify(folder) || util.slugify(CONFIG.DEFAULT_CATEGORY);
      if (slug && !categories.has(slug)) {
        categories.set(slug, {
          name: folder.split('/').pop(),
          slug,
          path: folder,
          position: categories.size
        });
      }

      const domain = urlUtils.domain(rawUrl);
      const title = String(record.title ?? '').replace(/\s+/g, ' ').trim();

      links.push({
        title: title || domain || 'Sem título',
        url: rawUrl,
        url_key: key,
        domain,
        category_slug: slug,
        tags: this.normalizeTags(record.tags),
        description: record.description ? String(record.description).slice(0, 2000) : null,
        favicon_url: this.pickIcon(record.iconUri),
        source: record.source || (format === 'linkspace' ? 'manual' : format),
        external_id: record.guid ? String(record.guid).slice(0, 200) : null,
        created_at: this.normalizeDate(record.dateAdded)
      });
    });

    return {
      categories: Array.from(categories.values()),
      links,
      stats: {
        total: records.length,
        duplicatesInFile,
        invalid
      }
    };
  }
};

/* ============================== 5. exporters ============================== */
const exporters = {
  toJson(links, categories) {
    const usedSlugs = new Set(links.map((link) => link.category_slug));
    const usedCategories = categories
      .filter((category) => usedSlugs.has(category.slug))
      .map((category) => ({ name: category.name, slug: category.slug, path: category.path || category.name }));

    return JSON.stringify({
      app: 'linkspace',
      version: 1,
      exported_at: new Date().toISOString(),
      count: links.length,
      categories: usedCategories,
      links: links.map((link) => ({
        title: link.title,
        url: link.url,
        url_key: link.url_key,
        domain: link.domain,
        category_slug: link.category_slug,
        tags: link.tags || [],
        description: link.description || null,
        created_at: link.created_at
      }))
    }, null, 2);
  },

  toNetscapeHtml(links, categories) {
    const nameBySlug = new Map(categories.map((category) => [category.slug, category.name]));
    const groups = new Map();

    links.forEach((link) => {
      const name = nameBySlug.get(link.category_slug) || CONFIG.DEFAULT_CATEGORY;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(link);
    });

    const esc = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const toSeconds = (value) => {
      const time = new Date(value).getTime();
      return Number.isNaN(time) ? Math.floor(Date.now() / 1000) : Math.floor(time / 1000);
    };

    const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));

    const body = sortedGroups.map(([name, items]) => {
      const anchors = items.map((link) => [
        `    <DT><A HREF="${esc(link.url)}" ADD_DATE="${toSeconds(link.created_at)}"`,
        link.favicon_url ? ` ICON_URI="${esc(link.favicon_url)}"` : '',
        '>',
        `${esc(link.title)}</A>`
      ].join(''));
      return [
        '  <DT><H3>' + esc(name) + '</H3>',
        '  <DL><p>',
        anchors.join('\n'),
        '  </DL><p>'
      ].join('\n');
    }).join('\n');

    return [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- This is an automatically generated file. It will be read and overwritten. -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<H1>Bookmarks</H1>',
      '<DL><p>',
      body,
      '</DL><p>',
      ''
    ].join('\n');
  },

  toCsv(links, categories) {
    const nameBySlug = new Map(categories.map((category) => [category.slug, category.name]));
    const header = ['titulo', 'url', 'categoria', 'dominio', 'tags', 'descricao', 'favorito', 'criado_em'];

    const cell = (value) => {
      const text = String(value ?? '');
      const needsQuotes = /[;"\n\r]/.test(text);
      const escaped = text.replace(/"/g, '""');
      return needsQuotes ? `"${escaped}"` : escaped;
    };

    const rows = links.map((link) => [
      link.title,
      link.url,
      nameBySlug.get(link.category_slug) || CONFIG.DEFAULT_CATEGORY,
      link.domain,
      (link.tags || []).join(', '),
      link.description || '',
      link.is_favorite ? 'sim' : 'nao',
      link.created_at || ''
    ].map(cell).join(';'));

    return `\uFEFF${header.join(';')}\n${rows.join('\n')}\n`;
  },

  filename(scope, extension) {
    const safeScope = util.slugify(scope) || 'todos';
    return `linkspace-${safeScope}-${util.today()}.${extension}`;
  },

  download(links, categories, format, scope) {
    if (format === 'html') {
      const html = this.toNetscapeHtml(links, categories);
      util.download(new Blob([html], { type: 'text/html;charset=utf-8' }), this.filename(scope, 'html'));
      return;
    }
    if (format === 'csv') {
      const csv = this.toCsv(links, categories);
      util.download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), this.filename(scope, 'csv'));
      return;
    }
    const json = this.toJson(links, categories);
    util.download(new Blob([json], { type: 'application/json;charset=utf-8' }), this.filename(scope, 'json'));
  }
};

/* ============================== 6. api ============================== */
/** Traduz erros do Supabase/rede para mensagens em pt-BR. */
function translateError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');

  if (code === 'PGRST205' || code === '42P01' || /could not find the table|relation .* does not exist/i.test(message)) {
    return MESSAGES.noSchema;
  }
  if (code === '401' || code === 'PGRST301' || /invalid api key|invalid jwt|jwt expired|api key/i.test(message)) {
    return MESSAGES.badKey;
  }
  if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(message)) {
    return MESSAGES.network;
  }
  if (code === '23505') return MESSAGES.duplicate;
  if (code === '429') return 'Muitas requisições ao banco. Aguarde alguns segundos.';
  if (code === '22023') return message;
  return message || MESSAGES.generic;
}

function isTransientError(error) {
  const message = String(error?.message || '');
  const status = Number(error?.status || 0);
  return /failed to fetch|networkerror|load failed|fetch failed|timeout/i.test(message) || status >= 500;
}

async function withRetry(task, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === attempts - 1) throw error;
      await util.sleep(300 * (3 ** attempt));
    }
  }
  throw lastError;
}

function rowToLink(row) {
  return {
    id: row.id,
    category_id: row.category_id || null,
    title: row.title || '',
    url: row.url || '',
    url_key: row.url_key || '',
    domain: row.domain || urlUtils.domain(row.url || ''),
    description: row.description || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    favicon_url: row.favicon_url || null,
    is_favorite: Boolean(row.is_favorite),
    position: row.position ?? 0,
    source: row.source || 'manual',
    external_id: row.external_id || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString()
  };
}

const api = {
  mode: 'supabase',
  client: null,
  demoStore: { links: [], categories: [], note: null },

  isDemo() {
    return this.mode === 'demo';
  },

  /** Cria o cliente Supabase (import dinâmico do CDN). */
  async connect(projectUrl, anonKey) {
    const { createClient } = await import(CONFIG.SUPABASE_CDN);
    this.client = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    this.mode = 'supabase';
    return this.client;
  },

  /** Testa URL + chave sem alterar a conexão atual. */
  async testConnection(projectUrl, anonKey) {
    try {
      const { createClient } = await import(CONFIG.SUPABASE_CDN);
      const temp = createClient(projectUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { error } = await temp.from(CONFIG.TABLES.categories).select('id').limit(1);
      if (error) return { ok: false, message: translateError(error) };
      return { ok: true, message: 'Conexão estabelecida com sucesso.' };
    } catch (error) {
      return { ok: false, message: translateError(error) };
    }
  },

  /* ------------------------------------------------------------------ demo */
  enableDemo() {
    this.mode = 'demo';
    this.demoStore = this.buildDemoStore();
  },

  disableDemo() {
    this.mode = 'supabase';
    this.demoStore = { links: [], categories: [], note: null };
  },

  buildDemoStore() {
    const now = Date.now();
    const daysAgo = (days) => new Date(now - days * 86400000).toISOString();

    const seedCategories = [
      ['SAUDE', 'saude'],
      ['INTELIGENCIA ARTIFICIAL', 'inteligencia-artificial'],
      ['PROGRAMAÇÃO', 'programacao'],
      ['VÍDEOS SISTEMAS SAUDE', 'videos-sistemas-saude'],
      ['DOWNLOAD', 'download'],
      ['DESIGN', 'design']
    ];

    const categories = seedCategories.map(([name, slug], index) => ({
      id: util.uid(),
      name,
      slug,
      path: name,
      parent_id: null,
      color: null,
      position: index,
      created_at: daysAgo(30),
      link_count: 0
    }));

    const bySlug = new Map(categories.map((category) => [category.slug, category]));

    const seedLinks = [
      ['PEC - Cidadão', 'https://esus.altolonga.pi.gov.br/', 'saude', 2],
      ['Relatórios SISAB', 'https://sisab.saude.gov.br/', 'saude', 3],
      ['e-SUS APS', 'https://aps.saude.gov.br/', 'saude', 5],
      ['TabNet — DATASUS', 'http://tabnet.datasus.gov.br/', 'saude', 8],
      ['Google Skills', 'https://skills.google/', 'inteligencia-artificial', 1],
      ['NotebookLM', 'https://notebooklm.google.com/', 'inteligencia-artificial', 4],
      ['Arena.ai', 'https://arena.ai/', 'inteligencia-artificial', 6],
      ['OpenRouter', 'https://openrouter.ai/', 'inteligencia-artificial', 9],
      ['MDN Web Docs', 'https://developer.mozilla.org/pt-BR/', 'programacao', 11],
      ['Supabase Docs', 'https://supabase.com/docs', 'programacao', 12],
      ['GitHub', 'https://github.com/', 'programacao', 14],
      ['Como instalar SISAIH01', 'https://www.youtube.com/results?search_query=sisaih01', 'videos-sistemas-saude', 7],
      ['Fechamento SISAIH01', 'https://www.youtube.com/results?search_query=fechamento+sisaih01', 'videos-sistemas-saude', 10],
      ['Internet Archive', 'https://archive.org/', 'download', 16],
      ['Material Icons', 'https://fonts.google.com/icons', 'design', 18],
      ['Lucide Icons', 'https://lucide.dev/', 'design', 20]
    ];

    const links = seedLinks.map(([title, url, slug, days], index) => {
      const category = bySlug.get(slug);
      const created = daysAgo(days);
      return rowToLink({
        id: util.uid(),
        category_id: category ? category.id : null,
        title,
        url,
        url_key: urlUtils.canonicalize(url),
        domain: urlUtils.domain(url),
        description: '',
        tags: index % 4 === 0 ? ['curso'] : [],
        favicon_url: null,
        is_favorite: index % 5 === 0,
        position: 0,
        source: 'manual',
        external_id: null,
        created_at: created,
        updated_at: created
      });
    });

    categories.forEach((category) => {
      category.link_count = links.filter((link) => link.category_id === category.id).length;
    });

    return {
      links,
      categories,
      note: {
        id: util.uid(),
        title: 'Anotações gerais',
        content_html: '',
        content_text: '',
        updated_at: null
      }
    };
  },

  /* -------------------------------------------------------------- leitura */
  async selectLinks() {
    if (this.isDemo()) return this.demoStore.links.map((link) => ({ ...link }));

    const data = await withRetry(async () => {
      const { data: rows, error } = await this.client
        .from(CONFIG.TABLES.links)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(CONFIG.MAX_LINKS);
      if (error) throw error;
      return rows || [];
    });
    return data.map(rowToLink);
  },

  async selectCategories() {
    if (this.isDemo()) return this.demoStore.categories.map((category) => ({ ...category }));

    return withRetry(async () => {
      const { data, error } = await this.client
        .from(CONFIG.TABLES.categoriesView)
        .select('*')
        .order('position', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map((category) => ({
        ...category,
        path: category.path || category.name,
        link_count: Number(category.link_count || 0)
      }));
    });
  },

  async getNote() {
    if (this.isDemo()) return this.demoStore.note ? { ...this.demoStore.note } : null;

    return withRetry(async () => {
      const { data, error } = await this.client
        .from(CONFIG.TABLES.notes)
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    });
  },

  /* -------------------------------------------------------------- escrita */
  async insertLink(payload) {
    if (this.isDemo()) {
      const row = rowToLink({ ...payload, id: payload.id || util.uid() });
      this.demoStore.links.unshift(row);
      this.refreshDemoCounts();
      return row;
    }

    return withRetry(async () => {
      const { data, error } = await this.client
        .from(CONFIG.TABLES.links)
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      return rowToLink(data);
    });
  },

  async updateLink(id, patch) {
    if (this.isDemo()) {
      const index = this.demoStore.links.findIndex((link) => link.id === id);
      if (index === -1) throw new Error('Link não encontrado.');
      const updated = rowToLink({ ...this.demoStore.links[index], ...patch, updated_at: new Date().toISOString() });
      this.demoStore.links[index] = updated;
      this.refreshDemoCounts();
      return updated;
    }

    return withRetry(async () => {
      const { data, error } = await this.client
        .from(CONFIG.TABLES.links)
        .update(patch)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return rowToLink(data);
    });
  },

  async deleteLink(id) {
    if (this.isDemo()) {
      this.demoStore.links = this.demoStore.links.filter((link) => link.id !== id);
      this.refreshDemoCounts();
      return true;
    }

    return withRetry(async () => {
      const { error } = await this.client
        .from(CONFIG.TABLES.links)
        .delete()
        .eq('id', id);
      if (error) throw error;
      return true;
    });
  },

  async ensureCategory(name) {
    const cleanName = String(name || '').trim();
    const slug = util.slugify(cleanName);
    if (!slug) throw new Error('Nome de categoria inválido.');

    if (this.isDemo()) {
      const existing = this.demoStore.categories.find((category) => category.slug === slug);
      if (existing) return existing;
      const category = {
        id: util.uid(),
        name: cleanName.toUpperCase(),
        slug,
        path: cleanName.toUpperCase(),
        parent_id: null,
        color: null,
        position: this.demoStore.categories.length,
        created_at: new Date().toISOString(),
        link_count: 0
      };
      this.demoStore.categories.push(category);
      return category;
    }

    return withRetry(async () => {
      const { data, error } = await this.client
        .from(CONFIG.TABLES.categories)
        .upsert({ name: cleanName.toUpperCase(), slug, path: cleanName.toUpperCase() }, { onConflict: 'slug' })
        .select()
        .single();
      if (error) throw error;
      return data;
    });
  },

  /** Importação transacional (RPC no Supabase; simulação em memória no demo). */
  async importPayload(payload, mode, source) {
    if (this.isDemo()) return this.simulateImport(payload, mode, source);

    return withRetry(async () => {
      const { data, error } = await this.client.rpc('import_links', {
        payload,
        p_mode: mode,
        p_source: source
      });
      if (error) throw error;
      return data || {};
    });
  },

  simulateImport(payload, mode, source) {
    if (mode === 'replace') {
      this.demoStore.links = [];
      this.demoStore.categories = [];
    }

    let categoriesCreated = 0;
    const bySlug = new Map(this.demoStore.categories.map((category) => [category.slug, category]));

    (payload.categories || []).forEach((category) => {
      if (!category || !category.slug) return;
      if (bySlug.has(category.slug)) return;
      const created = {
        id: util.uid(),
        name: category.name || category.slug,
        slug: category.slug,
        path: category.path || category.name || category.slug,
        parent_id: null,
        color: null,
        position: this.demoStore.categories.length,
        created_at: new Date().toISOString(),
        link_count: 0
      };
      this.demoStore.categories.push(created);
      bySlug.set(created.slug, created);
      categoriesCreated += 1;
    });

    const existingKeys = new Set(this.demoStore.links.map((link) => link.url_key));
    let inserted = 0;
    let duplicates = 0;
    let invalid = 0;

    (payload.links || []).forEach((link) => {
      if (!link || !link.url || !link.url_key) {
        invalid += 1;
        return;
      }
      if (existingKeys.has(link.url_key)) {
        duplicates += 1;
        return;
      }
      const category = bySlug.get(link.category_slug) || null;
      const row = rowToLink({
        id: util.uid(),
        category_id: category ? category.id : null,
        title: link.title,
        url: link.url,
        url_key: link.url_key,
        domain: link.domain,
        description: link.description,
        tags: link.tags,
        favicon_url: link.favicon_url,
        is_favorite: false,
        position: 0,
        source: link.source || source,
        external_id: link.external_id,
        created_at: link.created_at || new Date().toISOString()
      });
      this.demoStore.links.push(row);
      existingKeys.add(link.url_key);
      inserted += 1;
    });

    this.refreshDemoCounts();

    return {
      mode,
      total: (payload.links || []).length,
      inserted,
      duplicates,
      invalid,
      categories_created: categoriesCreated,
      simulated: true
    };
  },

  refreshDemoCounts() {
    this.demoStore.categories.forEach((category) => {
      category.link_count = this.demoStore.links.filter((link) => link.category_id === category.id).length;
    });
  },

  async saveNote(note) {
    const contentHtml = util.sanitizeHtml(note.content_html || '');
    const contentText = util.stripHtml(contentHtml);

    if (this.isDemo()) {
      const saved = {
        id: note.id || util.uid(),
        title: note.title || 'Anotações gerais',
        content_html: contentHtml,
        content_text: contentText,
        updated_at: new Date().toISOString()
      };
      this.demoStore.note = saved;
      return saved;
    }

    return withRetry(async () => {
      if (note.id) {
        const { data, error } = await this.client
          .from(CONFIG.TABLES.notes)
          .update({ content_html: contentHtml, content_text: contentText, updated_at: new Date().toISOString() })
          .eq('id', note.id)
          .select()
          .single();
        if (error) throw error;
        return data;
      }
      const { data, error } = await this.client
        .from(CONFIG.TABLES.notes)
        .insert({ title: note.title || 'Anotações gerais', content_html: contentHtml, content_text: contentText })
        .select()
        .single();
      if (error) throw error;
      return data;
    });
  },

  async saveSettings(patch) {
    if (this.isDemo()) return true;
    return withRetry(async () => {
      const { error } = await this.client.from(CONFIG.TABLES.settings).update(patch).eq('id', 1);
      if (error) throw error;
      return true;
    });
  }
};

/* ============================== 7. state ============================== */
const state = {
  status: 'idle',            // idle | loading | ready | error
  connection: 'unknown',     // unknown | checking | online | offline
  theme: 'light',
  organize: false,
  demo: false,
  filters: {
    query: '',
    filter: 'all',           // all | favorites | category
    categoryId: null
  },
  data: {
    links: [],
    categories: [],
    note: null
  },
  ui: {
    sidebarOpen: false,
    modal: null,
    visibleCount: CONFIG.PAGE_SIZE,
    saving: false,
    editingId: null,
    importPreview: null,
    export: null,
    confirm: null
  },
  meta: {
    loadedAt: 0,
    lastError: '',
    themeSynced: false
  }
};

const store = {
  listeners: [],

  get() {
    return state;
  },

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  },

  notify() {
    this.listeners.forEach((listener) => listener(state));
  },

  /** Atualização rasa de estado + notificação. */
  patch(patch) {
    Object.assign(state, patch);
    this.notify();
  }
};

/** Deriva o slug da categoria de cada link (usado na exportação). */
function decorateLinks(links, categories) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return links.map((link) => {
    const category = byId.get(link.category_id);
    return {
      ...link,
      category_slug: category ? category.slug : util.slugify(CONFIG.DEFAULT_CATEGORY),
      category_name: category ? category.name : CONFIG.DEFAULT_CATEGORY
    };
  });
}

/* ============================== 8. ui ============================== */
const els = {};

const ui = {
  modalStack: [],

  cacheElements() {
    const byId = (id) => document.getElementById(id);

    Object.assign(els, {
      grid: byId('grid'),
      loadMoreWrap: byId('load-more-wrap'),
      loadMore: byId('btn-load-more'),
      search: byId('search-input'),
      searchClear: byId('search-clear'),
      sidebar: byId('sidebar'),
      sidebarBackdrop: byId('sidebar-backdrop'),
      sidebarCategories: byId('sidebar-categories'),
      sidebarStats: byId('sidebar-stats'),
      navAll: document.querySelector('.nav-item[data-filter="all"]'),
      navFavorites: document.querySelector('.nav-item[data-filter="favorites"]'),
      countAll: document.querySelector('[data-count="all"]'),
      countFavorites: document.querySelector('[data-count="favorites"]'),
      contentTitle: byId('content-title'),
      contentCount: byId('content-count'),
      themeButton: byId('btn-theme'),
      organizeButton: byId('btn-organize'),
      newButton: byId('btn-new'),
      statusButton: byId('btn-status'),
      statusText: byId('status-text'),
      demoBanner: byId('demo-banner'),
      offlineBanner: byId('offline-banner'),
      offlineText: byId('offline-text'),
      toasts: byId('toasts'),
      menuButton: byId('btn-menu'),

      // anotações
      notesEditor: byId('notes-editor'),
      notesStatus: byId('notes-status'),
      notesSave: byId('notes-save'),
      notesToolbar: document.querySelector('.editor__toolbar'),

      // formulário de link
      linkForm: byId('link-form'),
      linkModalTitle: byId('link-title'),
      linkId: byId('link-id'),
      linkUrl: byId('link-url'),
      linkTitle: byId('link-title-input'),
      linkCategory: byId('link-category'),
      linkNewCategoryField: byId('new-category-field'),
      linkNewCategory: byId('link-new-category'),
      linkDescription: byId('link-description'),
      linkTags: byId('link-tags'),
      linkFavorite: byId('link-favorite'),
      linkError: byId('link-form-error'),
      linkHint: byId('link-form-hint'),
      linkSubmit: byId('link-submit'),
      linkUrlError: byId('link-url-error'),
      linkTitleError: byId('link-title-error'),

      // importação
      dropzone: byId('dropzone'),
      fileInput: byId('file-input'),
      importPreview: byId('import-preview'),
      importFileName: byId('import-file-name'),
      previewFormat: byId('preview-format'),
      previewTotal: byId('preview-total'),
      previewNew: byId('preview-new'),
      previewDupFile: byId('preview-dup-file'),
      previewDupDb: byId('preview-dup-db'),
      previewInvalid: byId('preview-invalid'),
      previewCategories: byId('preview-categories'),
      importProgress: byId('import-progress'),
      importProgressBar: byId('import-progress-bar'),
      importReport: byId('import-report'),
      importError: byId('import-error'),
      importRun: byId('import-run'),
      importDone: byId('import-done'),
      importCancel: byId('import-cancel'),

      // exportação
      exportSearch: byId('export-search'),
      exportList: byId('export-list'),
      exportCounter: byId('export-counter'),
      exportSelectAll: byId('export-select-all'),
      exportClear: byId('export-clear'),
      exportRun: byId('export-run'),

      // configurações
      settingsUrl: byId('settings-url'),
      settingsKey: byId('settings-key'),
      settingsDemo: byId('settings-demo'),
      settingsError: byId('settings-error'),
      settingsHint: byId('settings-hint'),
      settingsStats: byId('settings-stats'),

      // confirmação
      confirmTitle: byId('confirm-title'),
      confirmMessage: byId('confirm-message'),
      confirmInputWrap: byId('confirm-input-wrap'),
      confirmInputLabel: byId('confirm-input-label'),
      confirmInput: byId('confirm-input'),
      confirmOk: byId('confirm-ok')
    });
  },

  /* -------------------------------------------------------------- render */
  render() {
    this.renderTheme();
    this.renderHeaderActions();
    this.renderSidebar();
    this.renderContentHead();
    this.renderGrid();
    this.renderBanners();
    this.renderStatus();
    this.renderStats();
  },

  renderTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    if (els.themeButton) {
      const label = state.theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro';
      els.themeButton.setAttribute('aria-label', label);
      els.themeButton.title = label;
    }
  },

  renderHeaderActions() {
    if (!els.organizeButton) return;
    els.organizeButton.setAttribute('aria-pressed', String(state.organize));
    els.organizeButton.title = state.organize ? 'Sair do modo organizar' : 'Editar e excluir links';
    els.newButton.hidden = !state.organize;
  },

  renderSidebar() {
    if (!els.sidebarCategories) return;

    const counts = new Map();
    state.data.links.forEach((link) => {
      if (!link.category_id) return;
      counts.set(link.category_id, (counts.get(link.category_id) || 0) + 1);
    });

    els.navAll.classList.toggle('is-active', state.filters.filter === 'all');
    els.navFavorites.classList.toggle('is-active', state.filters.filter === 'favorites');
    els.countAll.textContent = String(state.data.links.length);
    els.countFavorites.textContent = String(state.data.links.filter((link) => link.is_favorite).length);

    const categories = [...state.data.categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    if (!categories.length) {
      els.sidebarCategories.innerHTML = '<p class="sidebar__stats">Nenhuma categoria ainda.</p>';
      return;
    }

    els.sidebarCategories.innerHTML = categories.map((category) => {
      const active = state.filters.filter === 'category' && state.filters.categoryId === category.id;
      return `
        <button class="nav-item nav-item--category${active ? ' is-active' : ''}" type="button"
                data-filter="category" data-category-id="${util.escapeHtml(category.id)}">
          <span class="nav-item__name">${util.escapeHtml(category.name)}</span>
          <span class="nav-item__count">${counts.get(category.id) || 0}</span>
        </button>`;
    }).join('');
  },

  renderContentHead() {
    const filtered = getFilteredLinks();
    const total = state.data.links.length;

    let title = 'Todos';
    if (state.filters.filter === 'favorites') title = 'Favoritos';
    if (state.filters.filter === 'category') {
      const category = state.data.categories.find((item) => item.id === state.filters.categoryId);
      title = category ? category.name : 'Categoria';
    }

    els.contentTitle.textContent = title;
    els.contentCount.textContent = state.filters.query
      ? `${filtered.length} de ${total} ${total === 1 ? 'link' : 'links'}`
      : `${filtered.length} ${filtered.length === 1 ? 'link' : 'links'}`;
  },

  renderGrid() {
    const container = els.grid;
    if (!container) return;

    container.classList.toggle('is-organizing', state.organize);

    if (state.status === 'loading' && state.data.links.length === 0) {
      container.innerHTML = `
        <div class="skeleton-group"></div>
        <div class="grid">
          ${Array.from({ length: 8 }, () => '<div class="skeleton-card"></div>').join('')}
        </div>`;
      els.loadMoreWrap.hidden = true;
      return;
    }

    if (state.status === 'error' && state.data.links.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <span class="empty__icon"><svg class="icon"><use href="#i-cloud-off"></use></svg></span>
          <p class="empty__title">Sem conexão com o banco</p>
          <p class="empty__text">${util.escapeHtml(state.meta.lastError || MESSAGES.offline)}</p>
          <div class="empty__actions">
            <button class="btn btn--primary" type="button" data-action="open-settings">Configurar Supabase</button>
            <button class="btn btn--outline" type="button" data-action="retry">Tentar novamente</button>
          </div>
        </div>`;
      els.loadMoreWrap.hidden = true;
      return;
    }

    if (state.data.links.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <span class="empty__icon"><svg class="icon"><use href="#i-bookmark"></use></svg></span>
          <p class="empty__title">Nenhum link por aqui</p>
          <p class="empty__text">Importe o backup de bookmarks do seu navegador ou cadastre o primeiro link.</p>
          <div class="empty__actions">
            <button class="btn btn--primary" type="button" data-action="open-import">Importar JSON</button>
            <button class="btn btn--outline" type="button" data-action="new-link">Novo Link</button>
          </div>
        </div>`;
      els.loadMoreWrap.hidden = true;
      return;
    }

    const filtered = getFilteredLinks();
    if (filtered.length === 0) {
      const term = state.filters.query.trim();
      container.innerHTML = `
        <div class="empty">
          <span class="empty__icon"><svg class="icon"><use href="#i-search"></use></svg></span>
          <p class="empty__title">${term ? `Nenhum resultado para “${util.escapeHtml(term)}”` : 'Nada encontrado'}</p>
          <p class="empty__text">Tente outro termo ou limpe os filtros.</p>
          <div class="empty__actions">
            <button class="btn btn--outline" type="button" data-action="clear-filters">Limpar busca</button>
          </div>
        </div>`;
      els.loadMoreWrap.hidden = true;
      return;
    }

    const groups = getGroups(filtered);
    let remaining = state.ui.visibleCount;
    let shown = 0;
    let html = '';

    for (const group of groups) {
      if (remaining <= 0) break;
      const slice = group.links.slice(0, remaining);
      if (!slice.length) continue;
      remaining -= slice.length;
      shown += slice.length;

      html += `
        <section class="group" aria-labelledby="group-${util.escapeHtml(group.id)}">
          <div class="group__head">
            <h2 class="group__title" id="group-${util.escapeHtml(group.id)}">${util.escapeHtml(group.name)}</h2>
            <span class="group__count">${group.links.length}</span>
          </div>
          <div class="grid">${slice.map(renderCard).join('')}</div>
        </section>`;
    }

    container.innerHTML = html;
    els.loadMoreWrap.hidden = shown >= filtered.length;
  },

  renderBanners() {
    els.demoBanner.hidden = !state.demo;
    const showOffline = state.connection === 'offline' && !state.demo;
    els.offlineBanner.hidden = !showOffline;
    if (showOffline && state.meta.lastError) {
      els.offlineText.textContent = state.meta.lastError;
    }
  },

  renderStatus() {
    if (!els.statusButton) return;

    if (state.demo) {
      els.statusButton.hidden = false;
      els.statusButton.className = 'status is-online';
      els.statusButton.title = 'Modo demonstração ativo (dados em memória)';
      els.statusText.textContent = 'Demonstração';
      return;
    }

    if (state.connection === 'checking') {
      els.statusButton.hidden = false;
      els.statusButton.className = 'status is-checking';
      els.statusButton.title = 'Conectando ao Supabase…';
      els.statusText.textContent = 'Conectando…';
      return;
    }

    if (state.connection === 'offline') {
      els.statusButton.hidden = false;
      els.statusButton.className = 'status';
      els.statusButton.title = state.meta.lastError || MESSAGES.offline;
      els.statusText.textContent = 'Erro ao conectar';
      return;
    }

    els.statusButton.hidden = true;
  },

  renderStats() {
    if (!els.sidebarStats) return;
    const links = state.data.links.length;
    const categories = state.data.categories.length;
    const lastSync = state.meta.loadedAt
      ? `Atualizado às ${util.formatTime(state.meta.loadedAt)}`
      : 'Ainda não sincronizado';
    els.sidebarStats.innerHTML = `${links} links · ${categories} categorias<br>${util.escapeHtml(lastSync)}`;
  },

  /* --------------------------------------------------------------- modais */
  openModal(name) {
    const element = document.getElementById(`modal-${name}`);
    if (!element || state.ui.modal === name) return;

    if (state.ui.modal) {
      this.hideModalElement(state.ui.modal);
      this.modalStack.push(state.ui.modal);
    } else {
      this.lastFocused = document.activeElement;
    }

    element.hidden = false;
    state.ui.modal = name;
    document.body.style.overflow = 'hidden';

    const focusable = element.querySelector(
      'input:not([type="hidden"]), select, textarea, [contenteditable="true"], button:not([disabled])'
    );
    if (focusable) {
      window.setTimeout(() => {
        if (!element.hidden) focusable.focus();
      }, 40);
    }
  },

  hideModalElement(name) {
    const element = document.getElementById(`modal-${name}`);
    if (element) element.hidden = true;
  },

  /** Fecha sem efeitos colaterais e devolve o modal anterior da pilha (se houver). */
  closeModalCore(name) {
    const target = name || state.ui.modal;
    if (!target) return;

    this.hideModalElement(target);

    const previous = this.modalStack.pop();
    if (previous) {
      const previousElement = document.getElementById(`modal-${previous}`);
      if (previousElement) previousElement.hidden = false;
      state.ui.modal = previous;
      document.body.style.overflow = 'hidden';
      return;
    }

    state.ui.modal = null;
    document.body.style.overflow = '';
    if (this.lastFocused && typeof this.lastFocused.focus === 'function') {
      this.lastFocused.focus();
    }
    this.lastFocused = null;
  },

  closeModal(name) {
    const target = name || state.ui.modal;
    if (!target) return;

    if (target === 'confirm') {
      this.resolveConfirm(false);
      return;
    }
    if (target === 'notes') {
      actions.closeNotes({ discard: false });
      return;
    }
    this.closeModalCore(target);
  },

  setSidebar(open) {
    state.ui.sidebarOpen = open;
    els.menuButton.setAttribute('aria-expanded', String(open));
    els.sidebar.setAttribute('aria-hidden', String(!open));

    if (open) {
      els.sidebarBackdrop.hidden = false;
      requestAnimationFrame(() => {
        els.sidebarBackdrop.classList.add('is-visible');
        els.sidebar.classList.add('is-open');
      });
    } else {
      els.sidebar.classList.remove('is-open');
      els.sidebarBackdrop.classList.remove('is-visible');
      window.setTimeout(() => {
        if (!state.ui.sidebarOpen) els.sidebarBackdrop.hidden = true;
      }, 220);
    }
  },

  confirm({ title = 'Confirmar', message = '', confirmLabel = 'Confirmar', danger = false, requireText = null }) {
    return new Promise((resolve) => {
      state.ui.confirm = { resolve };
      els.confirmTitle.textContent = title;
      els.confirmMessage.textContent = message;
      els.confirmOk.textContent = confirmLabel;
      els.confirmOk.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
      els.confirmInputWrap.hidden = !requireText;
      els.confirmInputLabel.textContent = requireText || '';
      els.confirmInput.value = '';
      els.confirmOk.disabled = Boolean(requireText);
      this.openModal('confirm');
    });
  },

  resolveConfirm(value) {
    const pending = state.ui.confirm;
    state.ui.confirm = null;
    this.closeModalCore('confirm');
    if (pending && pending.resolve) pending.resolve(value);
  },

  toast(message, type = 'info', action = null, timeout = 4000) {
    const element = document.createElement('div');
    element.className = `toast toast--${type}`;
    element.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.className = 'toast__text';
    text.textContent = message;
    element.appendChild(text);

    if (action && action.label) {
      const button = document.createElement('button');
      button.className = 'toast__btn';
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        action.onClick();
        element.remove();
      });
      element.appendChild(button);
    }

    els.toasts.appendChild(element);
    window.setTimeout(() => {
      element.style.opacity = '0';
      window.setTimeout(() => element.remove(), 220);
    }, timeout);
  }
};

/* ---------------------------------------------------- seletores derivados */
function getFilteredLinks() {
  const query = util.normalizeText(state.filters.query);
  const terms = query.split(' ').filter(Boolean);
  const categoriesById = new Map(state.data.categories.map((category) => [category.id, category]));

  return state.data.links.filter((link) => {
    if (state.filters.filter === 'favorites' && !link.is_favorite) return false;
    if (state.filters.filter === 'category' && link.category_id !== state.filters.categoryId) return false;
    if (!terms.length) return true;

    const category = categoriesById.get(link.category_id);
    const haystack = util.normalizeText([
      link.title,
      link.url,
      link.domain,
      category ? category.name : '',
      (link.tags || []).join(' ')
    ].join(' '));

    return terms.every((term) => haystack.includes(term));
  });
}

function getGroups(links) {
  const categoriesById = new Map(state.data.categories.map((category) => [category.id, category]));
  const groups = new Map();

  links.forEach((link) => {
    const category = categoriesById.get(link.category_id);
    const key = category ? category.id : 'none';
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: category ? category.name : 'SEM CATEGORIA',
        links: []
      });
    }
    groups.get(key).links.push(link);
  });

  const list = Array.from(groups.values());
  list.forEach((group) => {
    group.links.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  });
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return list;
}

function renderCard(link) {
  const domain = link.domain || urlUtils.domain(link.url);
  const hue = util.hue(domain || link.title || 'link');
  const mono = (domain || link.title || '?').charAt(0).toUpperCase();
  const favicon = link.favicon_url || (domain ? `${CONFIG.FAVICON_SERVICE}${encodeURIComponent(domain)}` : '');
  const iconStyle = `background:color-mix(in srgb, hsl(${hue} 60% 45%) 14%, transparent);color:hsl(${hue} 60% 45%)`;
  const safeTitle = util.escapeHtml(link.title || domain);

  return `
    <article class="card${link.is_favorite ? ' is-favorite' : ''}" data-id="${util.escapeHtml(link.id)}">
      <a class="card__main" href="${util.escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="${safeTitle}">
        <span class="card__icon" style="${iconStyle}">
          ${favicon
            ? `<img src="${util.escapeHtml(favicon)}" alt="" width="20" height="20" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${util.escapeHtml(mono)}">`
            : util.escapeHtml(mono)}
        </span>
        <span class="card__text">
          <span class="card__title">${safeTitle}</span>
          <span class="card__domain">${util.escapeHtml(domain)}</span>
        </span>
      </a>

      <button class="card__fav${link.is_favorite ? ' is-on' : ''}" type="button" data-action="toggle-favorite"
              aria-label="${link.is_favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}"
              aria-pressed="${String(link.is_favorite)}" title="Favorito">
        <svg class="icon"><use href="#i-star"></use></svg>
      </button>

      <div class="card__actions">
        <button class="card__action" type="button" data-action="edit" aria-label="Editar link" title="Editar">
          <svg class="icon"><use href="#i-pencil"></use></svg>
        </button>
        <button class="card__action card__action--danger" type="button" data-action="delete" aria-label="Excluir link" title="Excluir">
          <svg class="icon"><use href="#i-trash"></use></svg>
        </button>
      </div>
    </article>`;
}

/* ============================== 9. actions ============================== */
let notesSnapshot = null;
let lastImportReport = null;

/** Debounce com cancelamento (usado no autosave das anotações). */
function debounceWithCancel(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

const autosaveNotes = debounceWithCancel(() => actions.saveNote({ manual: false }), 1500);

const actions = {
  /* ------------------------------------------------------------- conexão */
  async connectAndLoad(config) {
    const cfg = config || readStoredConfig();
    state.connection = 'checking';
    ui.renderStatus();

    try {
      if (!api.isDemo()) {
        if (!cfg.url || !cfg.key) {
          state.connection = 'offline';
          state.meta.lastError = 'Configure a URL e a chave anon do Supabase.';
          ui.render();
          return false;
        }
        await api.connect(cfg.url, cfg.key);
      }
      const ok = await this.loadData();
      if (ok && !api.isDemo()) {
        ui.toast('Conectado ao Supabase.', 'success');
        api.saveSettings({ theme: state.theme }).catch(() => {});
      }
      return ok;
    } catch (error) {
      const message = translateError(error);
      state.connection = 'offline';
      state.meta.lastError = message;
      state.status = state.data.links.length ? 'ready' : 'error';
      ui.render();
      ui.toast(message, 'error');
      return false;
    }
  },

  async loadData(options = {}) {
    const silent = Boolean(options.silent);
    if (!silent && !state.data.links.length) {
      state.status = 'loading';
      ui.render();
    }

    try {
      const [links, categories, note] = await Promise.all([
        api.selectLinks(),
        api.selectCategories(),
        api.getNote().catch(() => null)
      ]);

      state.data.links = decorateLinks(links, categories);
      state.data.categories = categories;
      if (note) state.data.note = note;
      state.status = 'ready';
      state.connection = 'online';
      state.meta.loadedAt = Date.now();
      state.meta.lastError = '';

      writeCache();
      ui.render();
      return true;
    } catch (error) {
      const message = translateError(error);
      state.connection = 'offline';
      state.meta.lastError = message;
      state.status = state.data.links.length ? 'ready' : 'error';
      ui.render();
      if (!silent) ui.toast(message, 'error');
      return false;
    }
  },

  retry() {
    return this.connectAndLoad();
  },

  /* -------------------------------------------------------------- filtros */
  setQuery(value) {
    state.filters.query = String(value || '');
    state.ui.visibleCount = CONFIG.PAGE_SIZE;
    if (els.searchClear) els.searchClear.hidden = !state.filters.query;
    ui.renderContentHead();
    ui.renderGrid();
  },

  clearFilters() {
    state.filters = { query: '', filter: 'all', categoryId: null };
    state.ui.visibleCount = CONFIG.PAGE_SIZE;
    if (els.search) els.search.value = '';
    if (els.searchClear) els.searchClear.hidden = true;
    ui.render();
  },

  setFilter(filter, categoryId = null) {
    state.filters.filter = filter;
    state.filters.categoryId = filter === 'category' ? categoryId : null;
    state.ui.visibleCount = CONFIG.PAGE_SIZE;
    ui.render();
    if (window.matchMedia('(max-width: 760px)').matches) ui.setSidebar(false);
  },

  toggleOrganize() {
    state.organize = !state.organize;
    ui.renderHeaderActions();
    ui.renderGrid();
  },

  /* ---------------------------------------------------------------- tema */
  toggleTheme() {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    state.theme = next;
    try {
      localStorage.setItem(CONFIG.STORAGE.theme, next);
    } catch { /* ignora */ }
    ui.renderTheme();
    if (!api.isDemo()) {
      api.saveSettings({ theme: next }).catch(() => {});
    }
  },

  /* ---------------------------------------------------------------- links */
  openLinkModal(mode = 'new', id = null) {
    const editing = mode === 'edit' && id;
    const link = editing ? state.data.links.find((item) => item.id === id) : null;

    state.ui.editingId = editing ? id : null;
    els.linkModalTitle.textContent = editing ? 'Editar link' : 'Novo Link';
    els.linkSubmit.textContent = 'Salvar';
    els.linkError.hidden = true;
    els.linkUrlError.hidden = true;
    els.linkTitleError.hidden = true;
    els.linkUrl.classList.remove('is-invalid');
    els.linkTitle.classList.remove('is-invalid');
    els.linkHint.textContent = '';

    const options = ['<option value="">Sem categoria</option>'];
    [...state.data.categories]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .forEach((category) => {
        options.push(`<option value="${util.escapeHtml(category.id)}">${util.escapeHtml(category.name)}</option>`);
      });
    options.push('<option value="__new">+ Nova categoria…</option>');
    els.linkCategory.innerHTML = options.join('');

    if (link) {
      els.linkId.value = link.id;
      els.linkUrl.value = link.url;
      els.linkTitle.value = link.title;
      els.linkCategory.value = link.category_id || '';
      els.linkDescription.value = link.description || '';
      els.linkTags.value = (link.tags || []).join(', ');
      els.linkFavorite.checked = Boolean(link.is_favorite);
      els.linkNewCategoryField.hidden = true;
      els.linkNewCategory.value = '';
    } else {
      els.linkForm.reset();
      els.linkId.value = '';
      els.linkFavorite.checked = false;
      els.linkCategory.value = state.filters.filter === 'category' && state.filters.categoryId
        ? state.filters.categoryId
        : '';
      els.linkNewCategoryField.hidden = true;
      els.linkNewCategory.value = '';
      els.linkHint.textContent = `Categoria sugerida: ${getCategoryName(els.linkCategory.value) || 'nenhuma'}`;
    }

    ui.openModal('link');
  },

  async submitLinkForm(event) {
    event.preventDefault();

    const rawUrl = els.linkUrl.value.trim();
    const candidate = urlUtils.withScheme(rawUrl);
    const title = els.linkTitle.value.trim();

    els.linkUrlError.hidden = true;
    els.linkTitleError.hidden = true;
    els.linkUrl.classList.remove('is-invalid');
    els.linkTitle.classList.remove('is-invalid');

    let hasError = false;
    if (!urlUtils.isValid(candidate)) {
      els.linkUrlError.textContent = 'Informe uma URL válida (http:// ou https://).';
      els.linkUrlError.hidden = false;
      els.linkUrl.classList.add('is-invalid');
      hasError = true;
    }
    if (!title) {
      els.linkTitleError.textContent = 'O título é obrigatório.';
      els.linkTitleError.hidden = false;
      els.linkTitle.classList.add('is-invalid');
      hasError = true;
    }
    if (hasError) {
      (els.linkUrl.classList.contains('is-invalid') ? els.linkUrl : els.linkTitle).focus();
      return;
    }

    let categoryId = els.linkCategory.value || null;
    if (categoryId === '__new') {
      const name = els.linkNewCategory.value.trim();
      if (!name) {
        els.linkError.textContent = 'Informe o nome da nova categoria.';
        els.linkError.hidden = false;
        els.linkNewCategory.focus();
        return;
      }
      try {
        const created = await api.ensureCategory(name);
        categoryId = created.id;
      } catch (error) {
        els.linkError.textContent = translateError(error);
        els.linkError.hidden = false;
        return;
      }
    }

    const urlKey = urlUtils.canonicalize(candidate);
    const duplicate = state.data.links.find(
      (link) => link.url_key === urlKey && link.id !== state.ui.editingId
    );
    if (duplicate) {
      els.linkError.textContent = `Este link já existe na coleção (“${duplicate.title}”).`;
      els.linkError.hidden = false;
      return;
    }

    const payload = {
      title,
      url: candidate,
      url_key: urlKey,
      domain: urlUtils.domain(candidate),
      category_id: categoryId,
      description: els.linkDescription.value.trim() || null,
      tags: importers.normalizeTags(els.linkTags.value),
      is_favorite: els.linkFavorite.checked
    };

    els.linkError.hidden = true;
    els.linkSubmit.disabled = true;
    els.linkSubmit.textContent = 'Salvando…';

    try {
      if (state.ui.editingId) {
        await api.updateLink(state.ui.editingId, payload);
      } else {
        await api.insertLink({ ...payload, source: 'manual' });
      }
      await this.loadData({ silent: true });
      ui.closeModal('link');
      ui.toast('Link salvo.', 'success');
    } catch (error) {
      const message = translateError(error);
      els.linkError.textContent = message;
      els.linkError.hidden = false;
      ui.toast(message, 'error');
    } finally {
      els.linkSubmit.disabled = false;
      els.linkSubmit.textContent = 'Salvar';
    }
  },

  async requestDelete(id) {
    const link = state.data.links.find((item) => item.id === id);
    if (!link) return;

    const confirmed = await ui.confirm({
      title: 'Excluir link',
      message: `Tem certeza que deseja excluir “${link.title}”? Essa ação pode ser desfeita na notificação.`,
      confirmLabel: 'Excluir',
      danger: true
    });
    if (!confirmed) return;

    const snapshot = { ...link };
    const previous = state.data.links;
    state.data.links = state.data.links.filter((item) => item.id !== id);
    ui.render();

    try {
      await api.deleteLink(id);
      writeCache();
      ui.toast('Link excluído.', 'success', {
        label: 'Desfazer',
        onClick: () => this.undoDelete(snapshot)
      });
    } catch (error) {
      state.data.links = previous;
      ui.render();
      ui.toast(translateError(error), 'error');
    }
  },

  async undoDelete(snapshot) {
    try {
      await api.insertLink({
        id: snapshot.id,
        category_id: snapshot.category_id,
        title: snapshot.title,
        url: snapshot.url,
        url_key: snapshot.url_key,
        domain: snapshot.domain,
        description: snapshot.description || null,
        tags: snapshot.tags || [],
        favicon_url: snapshot.favicon_url || null,
        is_favorite: Boolean(snapshot.is_favorite),
        position: snapshot.position || 0,
        source: snapshot.source || 'manual',
        external_id: snapshot.external_id || null,
        created_at: snapshot.created_at
      });
      await this.loadData({ silent: true });
      ui.toast('Link restaurado.', 'success');
    } catch (error) {
      ui.toast(translateError(error), 'error');
    }
  },

  async toggleFavorite(id) {
    const link = state.data.links.find((item) => item.id === id);
    if (!link) return;

    const nextValue = !link.is_favorite;
    link.is_favorite = nextValue;
    ui.render();

    try {
      await api.updateLink(id, { is_favorite: nextValue });
      writeCache();
    } catch (error) {
      link.is_favorite = !nextValue;
      ui.render();
      ui.toast(translateError(error), 'error');
    }
  },

  /* ------------------------------------------------------------- anotações */
  async openNotes() {
    ui.openModal('notes');
    els.notesStatus.textContent = 'Carregando…';
    els.notesEditor.innerHTML = '';

    try {
      const note = await api.getNote();
      state.data.note = note || {
        id: null,
        title: 'Anotações gerais',
        content_html: '',
        content_text: '',
        updated_at: null
      };
      els.notesEditor.innerHTML = util.sanitizeHtml(state.data.note.content_html || '');
      notesSnapshot = els.notesEditor.innerHTML;
      els.notesStatus.textContent = state.data.note.updated_at
        ? `Salvo em ${util.formatDate(state.data.note.updated_at)} às ${util.formatTime(state.data.note.updated_at)}`
        : 'Ainda não salva';
    } catch (error) {
      els.notesStatus.textContent = 'Erro ao carregar';
      ui.toast(translateError(error), 'error');
    }
  },

  async saveNote(options = {}) {
    const manual = Boolean(options.manual);
    const html = util.sanitizeHtml(els.notesEditor.innerHTML);
    const text = util.stripHtml(html);

    if (!state.data.note) {
      state.data.note = { id: null, title: 'Anotações gerais', content_html: '', content_text: '' };
    }

    els.notesSave.disabled = true;
    if (manual) els.notesSave.textContent = 'Salvando…';

    try {
      const saved = await api.saveNote({
        id: state.data.note.id,
        title: state.data.note.title,
        content_html: html,
        content_text: text
      });
      state.data.note = { ...state.data.note, ...saved };
      els.notesStatus.textContent = `Salvo às ${util.formatTime(saved.updated_at || Date.now())}`;
      if (manual) ui.toast('Anotações salvas.', 'success');
      return true;
    } catch (error) {
      els.notesStatus.textContent = 'Erro ao salvar — alterações não sincronizadas';
      ui.toast(translateError(error), 'error');
      return false;
    } finally {
      els.notesSave.disabled = false;
      els.notesSave.textContent = 'Salvar Anotações';
    }
  },

  onNoteInput() {
    els.notesStatus.textContent = 'Alterações não salvas…';
    autosaveNotes();
  },

  async closeNotes(options = {}) {
    const discard = options.discard !== false;
    autosaveNotes.cancel();
    if (!discard && notesSnapshot !== null && util.sanitizeHtml(els.notesEditor.innerHTML) !== util.sanitizeHtml(state.data.note?.content_html || '')) {
      const saved = await this.saveNote();
      if (!saved) return;
    }

    if (discard && notesSnapshot !== null && state.data.note) {
      const current = util.sanitizeHtml(els.notesEditor.innerHTML);
      const stored = util.sanitizeHtml(state.data.note.content_html || '');

      if (current !== notesSnapshot && stored !== notesSnapshot) {
        try {
          const restored = await api.saveNote({
            id: state.data.note.id,
            title: state.data.note.title,
            content_html: notesSnapshot,
            content_text: util.stripHtml(notesSnapshot)
          });
          state.data.note = { ...state.data.note, ...restored };
        } catch { /* se falhar, mantém o que está no banco */ }
      }
      els.notesEditor.innerHTML = notesSnapshot;
    }

    notesSnapshot = null;
    ui.closeModalCore('notes');
  },

  updateToolbarState() {
    if (state.ui.modal !== 'notes' || !els.notesToolbar) return;
    els.notesToolbar.querySelectorAll('[data-command]').forEach((button) => {
      const command = button.dataset.command;
      let active = false;
      try {
        active = document.queryCommandState(command);
      } catch {
        active = false;
      }
      button.setAttribute('aria-pressed', String(active));
    });
  },

  applyFormat(command) {
    els.notesEditor.focus();
    try {
      document.execCommand(command, false, null);
    } catch { /* comando indisponível */ }
    this.updateToolbarState();
    this.onNoteInput();
  }
};

/** Nome da categoria a partir do id (usado em sugestões). */
function getCategoryName(categoryId) {
  const category = state.data.categories.find((item) => item.id === categoryId);
  return category ? category.name : '';
}

/* ------------------------------------------------------------- cache e config */
function readCache() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE.cache);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.links) || !Array.isArray(parsed.categories)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache() {
  try {
    localStorage.setItem(CONFIG.STORAGE.cache, JSON.stringify({
      links: state.data.links,
      categories: state.data.categories,
      ts: Date.now()
    }));
  } catch { /* quota cheia: cache é opcional */ }
}

function readStoredConfig() {
  let url = '';
  let key = '';
  try {
    url = localStorage.getItem(CONFIG.STORAGE.url) || '';
    key = localStorage.getItem(CONFIG.STORAGE.key) || '';
  } catch { /* ignora */ }
  return { url: url || CONFIG.SUPABASE_URL, key: key || CONFIG.SUPABASE_ANON_KEY };
}

function storeConfig(url, key) {
  try {
    localStorage.setItem(CONFIG.STORAGE.url, url);
    localStorage.setItem(CONFIG.STORAGE.key, key);
  } catch { /* ignora */ }
}

function isDemoEnabled() {
  try {
    return localStorage.getItem(CONFIG.STORAGE.demo) === '1';
  } catch {
    return false;
  }
}

function setDemoEnabled(enabled) {
  try {
    if (enabled) localStorage.setItem(CONFIG.STORAGE.demo, '1');
    else localStorage.removeItem(CONFIG.STORAGE.demo);
  } catch { /* ignora */ }
}

/* --------------------------------------------------------------- importação */
actions.openImport = function openImport() {
  state.ui.importPreview = null;
  lastImportReport = null;

  els.importPreview.hidden = true;
  els.importReport.hidden = true;
  els.importReport.innerHTML = '';
  els.importError.hidden = true;
  els.importProgress.hidden = true;
  els.importProgressBar.style.width = '0%';
  els.importRun.hidden = false;
  els.importRun.disabled = true;
  els.importRun.textContent = 'Importar';
  els.importDone.hidden = true;
  els.importCancel.hidden = false;
  els.importCancel.textContent = 'Cancelar';
  els.fileInput.value = '';
  els.dropzone.classList.remove('is-over');

  ui.openModal('import');
};

actions.handleFile = async function handleFile(file) {
  els.importError.hidden = true;
  els.importReport.hidden = true;

  if (!file) return;
  if (!/\.json$/i.test(file.name)) {
    els.importError.textContent = 'Selecione um arquivo .json exportado pelo navegador.';
    els.importError.hidden = false;
    return;
  }
  if (file.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
    els.importError.textContent = `Arquivo maior que ${CONFIG.MAX_FILE_MB} MB.`;
    els.importError.hidden = false;
    return;
  }

  els.importRun.disabled = true;
  els.importRun.textContent = 'Analisando…';

  try {
    const text = await file.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('JSON inválido: verifique se o arquivo não está corrompido.');
    }

    const format = importers.detectFormat(json);
    if (!format) {
      throw new Error('Formato não reconhecido. Aceitamos backups do Firefox, Chrome/Edge, do LinkSpace e listas [{ title, url }].');
    }

    const records = importers.parseRecords(json, format);
    if (!records.length) {
      throw new Error('Nenhum link encontrado no arquivo.');
    }
    if (records.length > CONFIG.MAX_LINKS) {
      throw new Error(`O arquivo tem ${records.length} itens; o limite é ${CONFIG.MAX_LINKS} por importação.`);
    }

    const payload = importers.buildPayload(records, format);
    const existingKeys = new Set(state.data.links.map((link) => link.url_key));
    const uniqueLinks = [...new Map(payload.links.map((link) => [link.url_key, link])).values()];
    const newLinks = uniqueLinks.filter((link) => !existingKeys.has(link.url_key));
    const existingSlugs = new Set(state.data.categories.map((category) => category.slug));
    const newCategories = payload.categories.filter((category) => !existingSlugs.has(category.slug));

    state.ui.importPreview = {
      payload,
      format,
      fileName: file.name,
      summary: {
        total: records.length,
        newLinks: newLinks.length,
        duplicatesInFile: payload.stats.duplicatesInFile,
        alreadyExisting: uniqueLinks.length - newLinks.length,
        invalid: payload.stats.invalid,
        newCategories: newCategories.length,
        categories: payload.categories.length
      }
    };

    const labels = {
      firefox: 'Firefox (places.json)',
      chrome: 'Chrome / Edge',
      linkspace: 'LinkSpace',
      generic: 'Genérico'
    };

    els.importFileName.textContent = `${file.name} — ${(file.size / 1024).toFixed(1)} KB`;
    els.previewFormat.textContent = labels[format] || format;
    els.previewTotal.textContent = String(records.length);
    els.previewNew.textContent = String(newLinks.length);
    els.previewDupFile.textContent = String(payload.stats.duplicatesInFile);
    els.previewDupDb.textContent = String(payload.links.length - newLinks.length);
    els.previewInvalid.textContent = String(payload.stats.invalid);
    els.previewCategories.textContent = String(newCategories.length);

    els.importPreview.hidden = false;
    els.importRun.disabled = newLinks.length === 0 && payload.stats.duplicatesInFile === 0;
    els.importRun.textContent = 'Importar';

    if (!newLinks.length) {
      els.importError.textContent = 'Todos os links deste arquivo já estão na sua coleção. Nada será duplicado.';
      els.importError.hidden = false;
    }
  } catch (error) {
    els.importRun.disabled = true;
    els.importRun.textContent = 'Importar';
    els.importError.textContent = error.message || String(error);
    els.importError.hidden = false;
  }
};

actions.runImport = async function runImport() {
  const preview = state.ui.importPreview;
  if (!preview) return;

  const modeField = document.querySelector('input[name="import-mode"]:checked');
  const mode = modeField ? modeField.value : 'merge';

  if (mode === 'replace') {
    const confirmed = await ui.confirm({
      title: 'Substituir todos os links',
      message: 'Esta ação apaga TODOS os links e categorias atuais antes de importar o arquivo. Digite APAGAR para confirmar.',
      confirmLabel: 'Apagar e importar',
      danger: true,
      requireText: 'APAGAR'
    });
    if (!confirmed) return;
  }

  const { payload, fileName } = preview;
  const total = payload.links.length;
  const chunkSize = total > 1000 ? CONFIG.BATCH_SIZE : Math.max(total, 1);
  const chunks = [];
  for (let index = 0; index < total; index += chunkSize) {
    chunks.push(payload.links.slice(index, index + chunkSize));
  }
  if (!chunks.length) chunks.push([]);

  els.importError.hidden = true;
  els.importRun.disabled = true;
  els.importRun.textContent = 'Importando…';
  els.importProgress.hidden = false;
  els.importProgressBar.style.width = '4%';

  const report = {
    mode,
    total: 0,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    categories_created: 0
  };

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkPayload = {
        categories: index === 0 ? payload.categories : [],
        links: chunks[index]
      };
      const chunkMode = mode === 'replace' && index > 0 ? 'merge' : mode;
      const partial = await api.importPayload(chunkPayload, chunkMode, fileName);

      report.total += Number(partial.total || 0);
      report.inserted += Number(partial.inserted || 0);
      report.duplicates += Number(partial.duplicates || 0);
      report.invalid += Number(partial.invalid || 0);
      report.categories_created += Number(partial.categories_created || 0);

      els.importProgressBar.style.width = `${Math.round(((index + 1) / chunks.length) * 100)}%`;
    }

    report.invalid += payload.stats.invalid;
    report.total += payload.stats.invalid;
    lastImportReport = { ...report, source_file: fileName, created_at: new Date().toISOString() };

    els.importReport.innerHTML = `
      <p><strong>Importação concluída.</strong>${api.isDemo() ? ' <em>(simulada em memória)</em>' : ''}</p>
      <ul>
        <li>Links novos: <strong>${report.inserted}</strong></li>
        <li>Duplicados ignorados: <strong>${report.duplicates}</strong></li>
        <li>Inválidos: <strong>${report.invalid}</strong></li>
        <li>Categorias criadas: <strong>${report.categories_created}</strong></li>
      </ul>
      <p style="margin-top:10px">
        <button class="btn btn--sm btn--outline" type="button" data-action="export-report">Exportar relatório</button>
      </p>`;
    els.importReport.hidden = false;

    els.importRun.hidden = true;
    els.importCancel.hidden = true;
    els.importDone.hidden = false;

    await this.loadData({ silent: true });
    ui.toast(
      report.inserted
        ? `${report.inserted} ${report.inserted === 1 ? 'link importado' : 'links importados'}.`
        : 'Nenhum link novo: o arquivo já estava importado.',
      report.inserted ? 'success' : 'info'
    );
  } catch (error) {
    els.importRun.disabled = false;
    els.importRun.textContent = 'Importar';
    els.importError.textContent = translateError(error);
    els.importError.hidden = false;
    els.importProgress.hidden = true;
    ui.toast(translateError(error), 'error');
  }
};

actions.exportReport = function exportReport() {
  if (!lastImportReport) return;
  const json = JSON.stringify(lastImportReport, null, 2);
  util.download(new Blob([json], { type: 'application/json;charset=utf-8' }), `linkspace-relatorio-importacao-${util.today()}.json`);
};

/* ---------------------------------------------------------------- exportação */
actions.openExport = function openExport() {
  const hasFilter = Boolean(state.filters.query) || state.filters.filter !== 'all';
  const base = hasFilter ? getFilteredLinks() : state.data.links;

  state.ui.export = {
    selected: new Set(base.map((link) => link.id)),
    query: ''
  };

  els.exportSearch.value = '';
  this.renderExportList();
  ui.openModal('export');
};

actions.renderExportList = function renderExportList() {
  const exportState = state.ui.export;
  if (!exportState) return;

  const query = util.normalizeText(exportState.query);
  const visible = state.data.links.filter((link) => {
    if (!query) return true;
    return util.normalizeText(`${link.title} ${link.url} ${link.domain} ${link.category_name || ''}`).includes(query);
  });

  if (!visible.length) {
    els.exportList.innerHTML = '<p class="export-list__empty">Nenhum link encontrado para o filtro.</p>';
    this.updateExportCounter();
    return;
  }

  const groups = new Map();
  visible.forEach((link) => {
    const name = link.category_name || CONFIG.DEFAULT_CATEGORY;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(link);
  });

  const ordered = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));

  els.exportList.innerHTML = ordered.map(([name, links], index) => {
    const items = links
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map((link) => `
        <label class="export-item">
          <input type="checkbox" data-export-id="${util.escapeHtml(link.id)}" ${exportState.selected.has(link.id) ? 'checked' : ''}>
          <span>
            <span class="export-item__title">${util.escapeHtml(link.title)}</span>
            <span class="export-item__url">${util.escapeHtml(link.url)}</span>
          </span>
        </label>`)
      .join('');

    return `
      <div class="export-group" data-group="${index}">
        <div class="export-group__head">
          <label class="export-group__label">
            <input type="checkbox" data-export-group="${index}">
            <span>${util.escapeHtml(name)} · ${links.length}</span>
          </label>
        </div>
        ${items}
      </div>`;
  }).join('');

  els.exportList.querySelectorAll('.export-group').forEach((group) => {
    const boxes = Array.from(group.querySelectorAll('[data-export-id]'));
    const checked = boxes.filter((box) => box.checked).length;
    const head = group.querySelector('[data-export-group]');
    if (!head) return;
    head.checked = boxes.length > 0 && checked === boxes.length;
    head.indeterminate = checked > 0 && checked < boxes.length;
  });

  this.updateExportCounter();
};

actions.updateExportCounter = function updateExportCounter() {
  const exportState = state.ui.export;
  if (!exportState) return;
  const count = exportState.selected.size;
  els.exportCounter.textContent = `${count} de ${state.data.links.length} selecionados`;
  els.exportRun.textContent = `Exportar ${count} ${count === 1 ? 'link' : 'links'}`;
  els.exportRun.disabled = count === 0;
};

actions.selectAllExport = function selectAllExport() {
  const exportState = state.ui.export;
  if (!exportState) return;
  els.exportList.querySelectorAll('[data-export-id]').forEach((box) => {
    box.checked = true;
    exportState.selected.add(box.dataset.exportId);
  });
  this.renderExportList();
};

actions.clearExportSelection = function clearExportSelection() {
  const exportState = state.ui.export;
  if (!exportState) return;
  exportState.selected.clear();
  els.exportList.querySelectorAll('[data-export-id]').forEach((box) => {
    box.checked = false;
  });
  els.exportList.querySelectorAll('[data-export-group]').forEach((head) => {
    head.checked = false;
    head.indeterminate = false;
  });
  this.updateExportCounter();
};

actions.runExport = function runExport() {
  const exportState = state.ui.export;
  if (!exportState || exportState.selected.size === 0) return;

  const formatField = document.querySelector('input[name="export-format"]:checked');
  const format = formatField ? formatField.value : 'json';

  const ordered = getGroups(state.data.links)
    .flatMap((group) => group.links)
    .filter((link) => exportState.selected.has(link.id));

  const scope = exportState.selected.size === state.data.links.length ? 'todos' : 'selecao';
  exporters.download(ordered, state.data.categories, format, scope);

  ui.toast(`${ordered.length} ${ordered.length === 1 ? 'link exportado' : 'links exportados'} (${format.toUpperCase()}).`, 'success');
  ui.closeModal('export');
};

/* --------------------------------------------------------------- configurações */
actions.openSettings = function openSettings() {
  const cfg = readStoredConfig();
  els.settingsUrl.value = cfg.url || '';
  els.settingsKey.value = cfg.key || '';
  els.settingsDemo.checked = state.demo;
  els.settingsError.hidden = true;
  els.settingsHint.textContent = '';

  const lastImport = state.meta.loadedAt ? `Atualizado às ${util.formatTime(state.meta.loadedAt)}` : 'Sem dados carregados';
  els.settingsStats.textContent = `${state.data.links.length} links · ${state.data.categories.length} categorias · ${lastImport}` + (state.demo ? ' · modo demonstração' : '');

  ui.openModal('settings');
};

actions.testConnection = async function testConnection() {
  const projectUrl = els.settingsUrl.value.trim();
  const anonKey = els.settingsKey.value.trim();

  els.settingsError.hidden = true;
  els.settingsHint.textContent = '';

  if (els.settingsDemo.checked) {
    els.settingsHint.textContent = 'Modo demonstração selecionado: os dados ficam em memória.';
    return;
  }
  if (!/^https?:\/\/.+/.test(projectUrl) || !anonKey) {
    els.settingsError.textContent = 'Informe a Project URL e a chave anon.';
    els.settingsError.hidden = false;
    return;
  }

  els.settingsHint.textContent = 'Testando…';
  const result = await api.testConnection(projectUrl, anonKey);
  els.settingsHint.textContent = result.message;
  if (!result.ok) {
    els.settingsError.textContent = result.message;
    els.settingsError.hidden = false;
  }
};

actions.saveSettings = async function saveSettings() {
  els.settingsError.hidden = true;

  if (els.settingsDemo.checked) {
    setDemoEnabled(true);
    state.demo = true;
    api.enableDemo();
    ui.closeModal('settings');
    await this.connectAndLoad();
    ui.toast('Modo demonstração ativado.', 'info');
    return;
  }

  const projectUrl = els.settingsUrl.value.trim().replace(/\/+$/, '');
  const anonKey = els.settingsKey.value.trim();

  if (!/^https?:\/\/.+/.test(projectUrl) || !anonKey) {
    els.settingsError.textContent = 'Informe a Project URL e a chave anon do Supabase.';
    els.settingsError.hidden = false;
    return;
  }

  setDemoEnabled(false);
  state.demo = false;
  api.disableDemo();
  storeConfig(projectUrl, anonKey);

  ui.closeModal('settings');
  const ok = await this.connectAndLoad({ url: projectUrl, key: anonKey });
  if (!ok) {
    this.openSettings();
  }
};

actions.leaveDemo = async function leaveDemo() {
  setDemoEnabled(false);
  state.demo = false;
  state.data = { links: [], categories: [], note: null };
  api.disableDemo();

  const cfg = readStoredConfig();
  if (cfg.url && cfg.key) {
    await this.connectAndLoad(cfg);
  } else {
    ui.render();
    this.openSettings();
  }
};

/* ============================== 10. app ============================== */
/** Ações disparadas por data-action em qualquer parte da interface. */
function handleDataAction(action, element) {
  const card = element.closest('[data-id]');
  const id = (card && card.dataset.id) || element.dataset.id || null;

  switch (action) {
    case 'edit': actions.openLinkModal('edit', id); return true;
    case 'delete': actions.requestDelete(id); return true;
    case 'toggle-favorite': actions.toggleFavorite(id); return true;
    case 'new-link': actions.openLinkModal('new'); return true;
    case 'open-import': actions.openImport(); return true;
    case 'open-settings': actions.openSettings(); return true;
    case 'clear-filters': actions.clearFilters(); return true;
    case 'retry': actions.retry(); return true;
    case 'export-report': actions.exportReport(); return true;
    default: return false;
  }
}

/** Mantém o Tab dentro do modal aberto. */
function trapFocus(event) {
  if (event.key !== 'Tab' || !state.ui.modal) return;
  const modal = document.getElementById(`modal-${state.ui.modal}`);
  if (!modal) return;

  const focusables = Array.from(modal.querySelectorAll(
    'button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [contenteditable="true"]'
  )).filter((element) => element.offsetParent !== null || element === document.activeElement);

  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindEvents() {
  /* ---------------------------------------------------------------- busca */
  const debouncedSearch = util.debounce((value) => actions.setQuery(value), 200);

  els.search.addEventListener('input', () => {
    els.searchClear.hidden = !els.search.value;
    debouncedSearch(els.search.value);
  });

  els.searchClear.addEventListener('click', () => {
    els.search.value = '';
    els.searchClear.hidden = true;
    actions.setQuery('');
    els.search.focus();
  });

  /* --------------------------------------------------------------- header */
  els.menuButton.addEventListener('click', () => ui.setSidebar(!state.ui.sidebarOpen));
  document.getElementById('btn-close-sidebar').addEventListener('click', () => ui.setSidebar(false));
  els.sidebarBackdrop.addEventListener('click', () => ui.setSidebar(false));

  document.getElementById('btn-notes').addEventListener('click', () => actions.openNotes());
  els.themeButton.addEventListener('click', () => actions.toggleTheme());
  els.organizeButton.addEventListener('click', () => actions.toggleOrganize());
  els.newButton.addEventListener('click', () => actions.openLinkModal('new'));
  els.statusButton.addEventListener('click', () => actions.openSettings());

  document.getElementById('btn-import').addEventListener('click', () => {
    ui.setSidebar(false);
    actions.openImport();
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    ui.setSidebar(false);
    actions.openExport();
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    ui.setSidebar(false);
    actions.openSettings();
  });
  document.getElementById('btn-retry').addEventListener('click', () => actions.retry());
  document.getElementById('btn-leave-demo').addEventListener('click', () => actions.leaveDemo());

  els.loadMore.addEventListener('click', () => {
    state.ui.visibleCount += CONFIG.PAGE_SIZE;
    ui.renderGrid();
  });

  /* ------------------------------------------------------------- sidebar */
  document.getElementById('sidebar-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    actions.setFilter(button.dataset.filter, button.dataset.categoryId || null);
  });

  /* --------------------------------------------------------- ações gerais */
  document.addEventListener('click', (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      const handled = handleDataAction(actionElement.dataset.action, actionElement);
      if (handled) event.preventDefault();
      return;
    }

    const closeElement = event.target.closest('[data-close]');
    if (closeElement) {
      event.preventDefault();
      if (closeElement.id === 'notes-cancel') actions.closeNotes({ discard: true });
      else ui.closeModal(closeElement.dataset.close);
    }
  });

  /* ------------------------------------------------------------ anotações */
  els.notesEditor.addEventListener('input', () => actions.onNoteInput());
  els.notesSave.addEventListener('click', () => actions.saveNote({ manual: true }));

  els.notesToolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('[data-command]')) event.preventDefault();
  });
  els.notesToolbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (button) actions.applyFormat(button.dataset.command);
  });
  document.addEventListener('selectionchange', () => actions.updateToolbarState());

  /* --------------------------------------------------------- formulário */
  els.linkForm.addEventListener('submit', (event) => actions.submitLinkForm(event));

  els.linkCategory.addEventListener('change', () => {
    const isNew = els.linkCategory.value === '__new';
    els.linkNewCategoryField.hidden = !isNew;
    if (isNew) els.linkNewCategory.focus();
  });

  els.linkUrl.addEventListener('blur', () => {
    if (!els.linkTitle.value.trim() && urlUtils.isValid(els.linkUrl.value)) {
      els.linkTitle.value = urlUtils.domain(els.linkUrl.value);
    }
  });

  /* ------------------------------------------------------------ importar */
  els.dropzone.addEventListener('click', (event) => {
    if (event.target === els.fileInput) return;
    els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove('is-over');
    });
  });
  els.dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
    actions.handleFile(file);
  });
  els.fileInput.addEventListener('change', () => {
    actions.handleFile(els.fileInput.files ? els.fileInput.files[0] : null);
    els.fileInput.value = '';
  });
  els.importRun.addEventListener('click', () => actions.runImport());
  els.importDone.addEventListener('click', () => ui.closeModal('import'));

  /* ------------------------------------------------------------ exportar */
  els.exportSearch.addEventListener('input', util.debounce(() => {
    if (!state.ui.export) return;
    state.ui.export.query = els.exportSearch.value;
    actions.renderExportList();
  }, 150));

  els.exportSelectAll.addEventListener('click', () => actions.selectAllExport());
  els.exportClear.addEventListener('click', () => actions.clearExportSelection());
  els.exportRun.addEventListener('click', () => actions.runExport());

  els.exportList.addEventListener('change', (event) => {
    const exportState = state.ui.export;
    if (!exportState) return;

    const item = event.target.closest('[data-export-id]');
    if (item) {
      if (item.checked) exportState.selected.add(item.dataset.exportId);
      else exportState.selected.delete(item.dataset.exportId);

      const group = item.closest('.export-group');
      if (group) {
        const boxes = Array.from(group.querySelectorAll('[data-export-id]'));
        const checked = boxes.filter((box) => box.checked).length;
        const head = group.querySelector('[data-export-group]');
        if (head) {
          head.checked = checked === boxes.length && boxes.length > 0;
          head.indeterminate = checked > 0 && checked < boxes.length;
        }
      }
      actions.updateExportCounter();
      return;
    }

    const groupHead = event.target.closest('[data-export-group]');
    if (groupHead) {
      const group = groupHead.closest('.export-group');
      if (!group) return;
      group.querySelectorAll('[data-export-id]').forEach((box) => {
        box.checked = groupHead.checked;
        if (groupHead.checked) exportState.selected.add(box.dataset.exportId);
        else exportState.selected.delete(box.dataset.exportId);
      });
      actions.updateExportCounter();
    }
  });

  /* -------------------------------------------------------- configurações */
  document.getElementById('settings-test').addEventListener('click', () => actions.testConnection());
  document.getElementById('settings-save').addEventListener('click', () => actions.saveSettings());

  document.getElementById('settings-toggle-key').addEventListener('click', (event) => {
    const isPassword = els.settingsKey.type === 'password';
    els.settingsKey.type = isPassword ? 'text' : 'password';
    event.currentTarget.textContent = isPassword ? 'Ocultar' : 'Mostrar';
    event.currentTarget.setAttribute('aria-label', isPassword ? 'Ocultar chave' : 'Mostrar chave');
  });

  els.settingsDemo.addEventListener('change', () => {
    els.settingsHint.textContent = els.settingsDemo.checked
      ? 'Modo demonstração: os dados ficam apenas na memória desta aba.'
      : '';
  });

  /* ---------------------------------------------------------- confirmação */
  els.confirmInput.addEventListener('input', () => {
    const required = (els.confirmInputLabel.textContent || '').trim();
    els.confirmOk.disabled = Boolean(required)
      && els.confirmInput.value.trim().toUpperCase() !== required.toUpperCase();
  });

  els.confirmInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !els.confirmOk.disabled) {
      event.preventDefault();
      els.confirmOk.click();
    }
  });

  els.confirmOk.addEventListener('click', () => {
    const required = (els.confirmInputLabel.textContent || '').trim();
    if (required && els.confirmInput.value.trim().toUpperCase() !== required.toUpperCase()) return;
    ui.resolveConfirm(true);
  });

  /* ------------------------------------------------------------- teclado */
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.ui.modal) {
        ui.closeModal();
        return;
      }
      if (state.ui.sidebarOpen) {
        ui.setSidebar(false);
        return;
      }
      if (document.activeElement === els.search && els.search.value) {
        els.search.value = '';
        els.searchClear.hidden = true;
        actions.setQuery('');
      }
      return;
    }

    trapFocus(event);

    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    const isSlash = event.key === '/' && !typing;
    const isSearchShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';

    if (isSlash || isSearchShortcut) {
      event.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });

  /* -------------------------------------------------- favicon com fallback */
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const holder = image.closest('.card__icon');
    if (!holder) return;
    holder.textContent = image.dataset.fallback || '?';
  }, true);

  /* ---------------------------------------------------------- reconectar */
  window.addEventListener('online', () => {
    if (state.connection === 'offline' && !api.isDemo()) actions.retry();
  });
}

/** Bootstrap da aplicação. */
async function init() {
  ui.cacheElements();
  state.theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  bindEvents();

  const cached = readCache();
  if (cached) {
    state.data.categories = cached.categories;
    state.data.links = decorateLinks(cached.links, cached.categories);
    state.status = 'ready';
    state.meta.loadedAt = cached.ts || 0;
  }

  const demoEnabled = isDemoEnabled();
  state.demo = demoEnabled;
  state.ui.visibleCount = CONFIG.PAGE_SIZE;
  ui.render();

  if (demoEnabled) {
    api.enableDemo();
    state.data = { links: [], categories: [], note: null };
    state.status = 'loading';
    ui.render();
    await actions.connectAndLoad();
    return;
  }

  const config = readStoredConfig();
  if (!config.url || !config.key) {
    state.status = 'ready';
    ui.render();
    actions.openSettings();
    return;
  }

  await actions.connectAndLoad(config);
}

/* Exposto para depuração e testes automatizados (não usado pela interface). */
window.LinkSpace = { CONFIG, util, urlUtils, importers, exporters, api, state, store, actions, ui, init };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
