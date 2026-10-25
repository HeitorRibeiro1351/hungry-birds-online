# Hungry Birds Tycoon Online

Este pacote mantém o jogo original em `public/index.html` e acrescenta contas online (sem e-mail), nomes exclusivos no banco PostgreSQL, avatares e uma batalha real de produção de milho de 60 segundos usando WebSocket. A partida só começa quando dois usuários reais entram na fila.

## Publicar pelo celular

1. Extraia o ZIP no celular ou crie um repositório no GitHub e envie todos os arquivos desta pasta.
2. No Render, crie um banco **PostgreSQL** e copie a URL de conexão interna (ou a URL externa se o banco estiver fora do Render).
3. Crie um **Web Service** a partir do repositório. O Render detecta `render.yaml`; use `npm install` como Build Command e `npm start` como Start Command.
4. Em Environment, configure `DATABASE_URL` com a URL do PostgreSQL e `JWT_SECRET` com uma chave aleatória longa. `NODE_ENV=production` também deve estar definido.
5. Espere o deploy terminar e abra a URL `https://...onrender.com` no navegador. Para testar a batalha, abra a página em dois dispositivos/contas e clique em “Encontrar jogador” nos dois.

## Observações importantes

- O servidor **não precisa de e-mail**. O nome é único sem diferenciar maiúsculas/minúsculas.
- As senhas são armazenadas como hash bcrypt; nunca são guardadas em texto puro.
- O PostgreSQL é necessário para as contas persistirem depois de reinicializações. Não remova nem recrie o banco se quiser manter as contas.
- O plano gratuito do Render pode suspender o serviço após inatividade e pode haver limites/custos no banco de dados, conforme o plano disponível na sua conta.
- O jogo original continua salvando o progresso principal localmente no navegador. Este pacote ainda não sincroniza moedas, upgrades ou progresso do tycoon no banco online; as contas e a batalha multiplayer são online.
- A batalha valida os cliques no servidor e limita a frequência para reduzir trapaças simples, mas não é uma proteção anti-cheat profissional.
