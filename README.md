# LinkSpace

Organizador pessoal de favoritos em HTML, CSS e JavaScript nativos, com Supabase como fonte de dados. Importa backups Firefox, Chrome/Edge, JSON LinkSpace e listas genéricas; exporta JSON, HTML de favoritos e CSV. Inclui categorias, busca, edição, exclusão com desfazer, tema e anotações ricas.

## Instalação

1. Crie um projeto Supabase e abra **SQL Editor → New query**. Execute todo o arquivo [`supabase/schema.sql`](supabase/schema.sql).
2. Em **Project Settings → API** (ou Connect/API Keys, conforme a versão do painel), copie a URL do projeto e a chave pública **anon** ou chave publicável compatível. Nunca use a chave `service_role`.
3. Sirva o diretório por HTTP. Por exemplo, execute `python3 -m http.server 8000` na pasta do projeto e acesse `http://localhost:8000`. Também é possível publicar os arquivos em qualquer hospedagem estática, como GitHub Pages. A primeira conexão requer acesso à internet para carregar o cliente Supabase via CDN.
4. No modal de configuração, informe a URL e a chave, teste e salve. O navegador guarda ambas em localStorage. Escolha Importar na barra lateral e selecione o JSON de favoritos.

O modo de demonstração usa apenas a memória da aba, com dados de exemplo: alterações desaparecem ao recarregar e não são gravadas no Supabase. Desative-o nas configurações para conectar ao banco.

## Uso

- A barra lateral filtra por categoria ou favoritos; a busca ignora acentos. `/` ou Ctrl/⌘+K foca a busca.
- Em **Organizar**, edite, exclua ou crie links. Uma exclusão bem-sucedida pode ser desfeita pelo toast.
- A importação compara URLs normalizadas, preservando a URL original. Em **Substituir**, todos os links e categorias existentes são apagados. Confira a prévia antes de confirmar. Arquivos até 5 MB e 5.000 itens são aceitos; para mais de 1.000 links, são enviados lotes de 500. Cada chamada RPC é transacional, mas o conjunto de lotes não é uma única transação: se um lote falhar, os anteriores permanecem gravados. Reimporte em modo mesclar para retomar.
- A exportação permite selecionar links e gera JSON reimportável, HTML Netscape para navegadores ou CSV com separador `;`. Em Anotações, alterações são salvas automaticamente; Cancelar tenta restaurar o conteúdo da abertura.
- O cache local serve apenas para renderização inicial/offline e não substitui o banco. O tema fica também no navegador para evitar flash na abertura.

## Segurança e privacidade

**O schema padrão é pessoal, sem autenticação: suas políticas RLS permitem acesso de leitura e escrita com a chave pública anon. Qualquer pessoa com a URL e essa chave poderá ler, alterar ou apagar os dados, mesmo que a interface não esteja publicada.** A chave anon não é um segredo e guardá-la no navegador não protege o banco. Não utilize este modo para dados sensíveis ou aplicações públicas. O bloco comentado no final do schema é apenas um ponto de partida para implementar autenticação e isolamento por usuário; não ativa essa proteção sozinho.

Ao exibir favicons sem URL própria, o navegador pode consultar o serviço de favicons do Google, revelando o domínio do link. Não coloque segredos nas URLs dos favoritos. O editor sanitiza o HTML aceito, mas este app não substitui uma política de segurança ou controle de acesso no servidor.

## Estrutura

- `index.html`: interface e tema inicial.
- `styles.css`: estilos e responsividade.
- `app.js`: parsing, canonicalização, exportação, API, estado e interface.
- `supabase/schema.sql`: tabelas, índices, RLS e RPC de importação.
- `docs/`: documentos anteriores de arquitetura e especificação.
