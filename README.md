# LinkSpace — organizador de links (favoritos)

Organizador pessoal de links com **importação idempotente de bookmarks**, exportação
seletiva, categorias, busca, modo de organização, tema claro/escuro e anotações ricas
salvas no **Supabase**.

> **Status:** arquitetura e prompt de implementação prontos. O app ainda não foi gerado.

## Documentação

| Documento | Para quê |
|---|---|
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Arquitetura completa: escopo, casos de uso, modelo de dados, import/export, UI, segurança, roadmap e critérios de aceite |
| [`docs/PROMPT.md`](docs/PROMPT.md) | **Super prompt** pronto para colar em um agente de código (versão completa, curta e de continuação) |
| [`supabase/schema.sql`](supabase/schema.sql) | Schema do banco: tabelas, índices, triggers, views, RPC de importação, RLS e grants |

## Como usar (próximo passo)

1. Crie um projeto no [Supabase](https://supabase.com) (região São Paulo).
2. SQL Editor → cole e execute `supabase/schema.sql`.
3. Project Settings → API → copie **Project URL** e **anon public key**.
4. Abra `docs/PROMPT.md` e cole o prompt completo em um agente de código, **anexando o
   seu arquivo de bookmarks** (`bookmarks-2026-11-13.json`).
5. Sirva o resultado com `python3 -m http.server 8000` e informe URL + chave na tela de
   configuração do app.

## Resultado esperado

- `index.html`, `styles.css`, `app.js` + `supabase/schema.sql`
- Importar o backup de exemplo (175 links, 12 pastas) → ~11 categorias, ~174 links;
  reimportar → 0 novos e 175 duplicados ignorados
- Exportação em JSON (round-trip), HTML importável em navegadores e CSV

## Estrutura do repositório

```
.
├── index.html            # (a gerar)
├── styles.css            # (a gerar)
├── app.js                # (a gerar)
├── supabase/schema.sql   # banco pronto para executar
└── docs/
    ├── ARQUITETURA.md
    └── PROMPT.md
```
