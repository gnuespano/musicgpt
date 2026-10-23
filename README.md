# MusicGPT (clone)

Estúdio pessoal de criação musical com IA: **prompt → letra → melodia → vozes → instrumentais → faixa final**, com player, playlists, biblioteca e exportação.

Clone funcional e **offline-first** do app descrito na ficha da loja. Não é um mock: cada faixa gerada é um **arquivo de áudio real** (WAV 44.1 kHz estéreo), renderizado por um motor de síntese próprio.

```
npm start          # http://localhost:8787
```

Sem build step, sem framework, sem bundler. Uma dependência (`@breezystack/lamejs`) só para exportar MP3.

---

## 1. Recursos e onde estão implementados

| # | Recurso da ficha | Implementação |
|---|---|---|
| 1 | **Gerador de músicas com IA** | `server/providers/acestep.js` (ACE-Step 1.5 — API oficial `acemusic.ai`, padrão) + `server/audio/render.js` (motor de síntese local, fallback). Prompt → estrutura, tom, acordes, bateria, baixo, arpejo, melodia e voz. |
| 2 | **Modelo de música com IA personalizado** | Aba **Meu modelo**: perfil criativo (gêneros favoritos, energia, brilho, variação de andamento, caráter da voz) que é aplicado como modificador de estilo nas gerações. |
| 3 | **Gerador de letras** | `server/lyrics.js` — letra completa com tags em inglês (`[Verse]`, `[Pre-Chorus]`, `[Chorus]`, `[Bridge]`, `[Outro]`) **ou** colaboração linha a linha. Concordância de gênero (artigos, possessivos, preposições) em pt-BR e inglês. |
| 4 | **Player de música inteligente** | Barra inferior: play/pause, anterior/próxima, seek clicável, volume, mute, aleatório, repetir, fila, export e compartilhamento — mais o **visualizador de espectro** em tempo real (Web Audio API). |
| 5 | **Playlists e gerenciamento** | CRUD completo de playlists; faixas podem ser adicionadas/removidas; busca e filtro por gênero na biblioteca. |
| 6 | **Biblioteca musical com IA** | Biblioteca persistente com waveform, BPM, tom, estrutura, plays; aba **Explorar** com ideias da comunidade e faixas publicadas. |
| 7 | **Exportar e compartilhar** | Botão **"Baixar .wav"** e **"Baixar .mp3"** no painel de resultado, no card da faixa e no player; compartilhamento via Web Share API ou link copiado. O download resolve a **URL original do provider**, então funciona mesmo com o disco efêmero da nuvem (ver 5.2). |
| 8 | **Áudio de referência (Audio-to-Audio / Style Transfer)** | Botão **"Áudio ref."** na tela *Criar*: anexe um arquivo de áudio e a música nova nasce **com o timbre/instrumentação do arquivo** (`server/upload.js` + `server/audio/reference.js` + `server/providers/acestep.js`). Ver 4.0.1. |
| 9 | **Cover (manter a melodia)** | O mesmo áudio pode ser usado como **áudio de origem** (`src_audio`, `task_type: "cover"`): o modelo tenta manter a melodia e a estrutura originais. Ver 4.0.2. |

### Duração e camadas extras

- **Duração: 25 s a 2 min** (`MAX_DURATION_SEC = 120` em `server/audio/render.js`). O teto é garantido em três níveis: slider da interface, validação da API (`Math.min(MAX_DURATION_SEC, ...)`) e o próprio motor, que **encurta a estrutura** (remove outro/ponte) se o andamento natural do gênero não couber nos 2 minutos.
- **Opção Lo-fi**: quando ligada, injaja uma camada de **chuva ambiente** no fundo da mixagem — ruído branco → passa-baixa em cascata (2 polos, corte em 1,8 kHz) → corte de graves (140 Hz), com rajadas lentas (LFO de 0,07 Hz e 0,23 Hz) e dois canais de ruído independentes (imagem estéreo larga). Medido: −5 dB @ 1,8 kHz, −19 dB @ 6 kHz, −34 dB @ 20 kHz, a −20 dB em relação à música.
- **Visualizador de espectro**: faixa de barras animadas no topo do player (canvas 2D + Web Audio API). Detalhes abaixo.

### Visualizador de espectro (Web Audio API)

O player tem uma **faixa de barras** no topo que reage à frequência da música em tempo real.

```
<audio> ──▶ MediaElementAudioSourceNode ──▶ AnalyserNode ──▶ GainNode ──▶ speakers
                                              │
                                              └─▶ getByteFrequencyData() ──▶ canvas 2D
```

- **Captura**: o `<audio>` vira a fonte do grafo de áudio (`createMediaElementSource`), que alimenta um `AnalyserNode` (`fftSize = 2048`). Os bins são agrupados em barras com **escala logarítmica** (mais resolução nas frequências graves, onde mora a energia da música).
- **Desenho**: `requestAnimationFrame` desenha as barras num `<canvas>` 2D com as cores do tema (`--brand` roxo → `--brand-2` violeta → azul), com ataque rápido e relaxamento lento (as barras "respiram" como um VU real).
- **Pausa/play**: o `requestAnimationFrame` é cancelado no evento `pause` (o último quadro fica congelado e esmaecido) e religado no `play`.
- **Volume**: com o elemento ligado ao grafo, os navegadores **ignoram** `volume`/`muted` do `<audio>` — por isso o controle do player passa pelo `GainNode` (`applyVolume()`), e não pelo atributo do elemento.
- **Responsivo**: o buffer do canvas é recalculado no `resize`/`orientationchange` e por `ResizeObserver`, respeitando o `devicePixelRatio` (limitado a 2× para não pesar no celular). A faixa encolhe no mobile (`--spectrum-h`) e o player ganha altura (`--player-h`) para acomodá-la sem empurrar o conteúdo.
- **Fallback**: sem Web Audio API (ou se o navegador bloquear o `AudioContext`), o app continua tocando normalmente — só não há visualização.

Teste automatizado (Chromium headless via CDP; a suíte completa soma **199 verificações**):

```bash
npm test              # precisa do servidor no ar (npm start)
```

### 5.2 Download sem depender do disco (deploy na nuvem)

No Render (plano free) o disco é **efêmero**: o arquivo em `data/tracks/` some no próximo deploy. A rota de download não pode, portanto, depender do disco.

**Como funciona.** Cada faixa guarda a `audio_url` original devolvida pelo provider:

| Provider | O que a API devolve | O que é salvo em `track.sourceUrl` |
|---|---|---|
| ACE-Step 1.5 | `choices[0].message.audio[0].audio_url.url` = **data URL** (`data:audio/mpeg;base64,…`) | a própria data URL (o audio inteiro) |
| Replicate | URL https do arquivo gerado | a URL https |
| fal | URL https do arquivo gerado | a URL https |
| motor local | — (o áudio nasce no servidor) | — (usa o arquivo local) |

A rota `GET /api/download/:id` resolve a fonte assim:

```
1. sourceUrl original  ->  data URL (decodifica) ou https (faz proxy do arquivo)
2. data/tracks/<file>  ->  fallback: o mesmo audio em cache local
```

E garante o **formato pedido**:

| Pedido | Fonte MP3 | Fonte WAV |
|---|---|---|
| `?format=mp3` | served como está | convertido com **lamejs** (160 kbps) |
| `?format=wav` | decodificado (`@audio/decode-mp3`) e re-encodado em WAV | served como está |

A resposta sempre leva `Content-Disposition: attachment; filename="<slug>.mp3"` (mais `filename*=UTF-8''…` para títulos com acento), e o player (`/api/tracks/:id/audio`) também cai para a URL original quando o arquivo local some.

```bash
curl -OJ "localhost:8787/api/download/trk_xxx?format=mp3"   # baixa o MP3
curl -OJ "localhost:8787/api/download/trk_xxx?format=wav"   # baixa o WAV
curl -OJ "localhost:8787/api/download/trk_xxx?format=mp3&source=remote"  # força a URL original
```

> A `sourceUrl` **nunca** vai para o browser: a API devolve só um `hasSource: true`. Sem isso, a biblioteca viraria um arquivo de megabytes de base64.

**Variáveis:**

| Variável | Padrão | Efeito |
|---|---|---|
| `MUSICGPT_KEEP_SOURCE_AUDIO` | `1` | `0` = não guarda a data URL do ACE-Step (biblioteca fica leve, mas o download volta a depender do arquivo local) |

Teste automatizado (17 verificações, inclui o cenário de disco efêmero e o download real no navegador):

```bash
npm run test:download
MUSICGPT_TEST_RESTART=1 npm run test:download   # confere o download depois de reiniciar o servidor
```

---

## 2. Arquitetura

```
musicgpt/
├── server/
│   ├── index.js            # HTTP server, router, arquivos estáticos
│   ├── api.js              # handlers REST + SSE de progresso
│   ├── config.js           # env, providers, caminhos
│   ├── store.js            # persistência JSON (library, playlists, profile)
│   ├── upload.js           # upload multipart do áudio de referência (multer)
│   ├── lyrics.js           # gerador de letras (templates com concordância)
│   ├── theory.js           # escalas, acordes, progressões, presets de gênero
│   ├── providers/
│   │   ├── acestep.js      # ACE-Step 1.5 (API oficial acemusic.ai) - motor padrão
│   │   ├── music.js        # acestep | local | replicate | fal
│   │   └── lyrics.js       # local | openrouter | openai
│   └── audio/
│       ├── render.js       # composição + síntese (bateria, baixo, pad, arp, lead, voz)
│       ├── dsp.js          # osciladores, envelopes, filtros, reverb, limiting
│       ├── wav.js          # encode/decode WAV PCM16
│       ├── mp3.js          # encode MP3 (lamejs)
│       ├── remote.js       # download + parsing de duração de MP3/WAV
│       ├── reference.js    # áudio de referência (base64 + formato p/ o ACE-Step)
│       └── worker.js       # render em worker thread (servidor não trava)
├── public/                 # SPA (HTML + CSS + JS puro, sem build)
├── scripts/
│   ├── gerar-certificado.mjs   # certificado self-signed para HTTPS local
│   ├── lib/cdp.mjs             # cliente CDP compartilhado pelos testes
│   ├── provar-acestep.mjs      # sonda: o que a API do ACE-Step devolve
│   ├── testar-audio-referencia.mjs  # teste do upload do áudio de referência
│   ├── testar-estilo-prioridade.mjs # teste da prioridade do texto de Estilos
│   ├── testar-modo-audio.mjs     # teste do modo do áudio (estilo x cover)
│   ├── testar-fidelidade.mjs     # mede a fidelidade de um cover (croma/melodia)
│   ├── testar-espectro.mjs     # teste do visualizador (Chromium headless + CDP)
│   └── testar-download.mjs     # teste do download (disco efemero, MP3/WAV)
└── data/                   # library.json, playlists.json, profile.json, tracks/
```

### Decisões de projeto

- **Zero framework no front-end.** A UI é uma SPA em JS puro: sem build, sem `node_modules` no browser, carrega instantâneo e funciona offline.
- **Renderização fora do thread principal.** A síntese roda em `worker_threads`; o servidor continua respondendo e o progresso chega ao browser por **SSE** (`/api/jobs/:id/events`).
- **Áudio como fonte da verdade.** O master é WAV em disco; o MP3 é derivado sob demanda e cacheado. O player usa **HTTP Range**, então dá para arrastar a barra de progresso.
- **Determinismo.** Prompt + seed ⇒ mesma música. A seed é derivada do hash do prompt quando não informada.

---

## 3. O motor de síntese (motor local)

Sem modelo treinado: o áudio é **composto proceduralmente**, mas musicalmente coerente.

1. **Leitura do prompt** → gênero, clima, tom, andamento (`detectGenre` / `detectMood` por palavra-chave).
2. **Estrutura** → Intro / Verso / Pré-Refrão / Refrão / Verso 2 / Refrão / Ponte / Refrão final / Outro, dimensionada pela duração pedida (o andamento é recalculado para caber no tempo).
3. **Harmonia** → progressões por gênero (ex.: sertanejo `I–vi–IV–V`, trap `i–VI–IV–v`), acordes triádicos/diatônicos na escala escolhida.
4. **Arranjo** → bateria (16 passos por gênero: samba, pagode, trap, house, baile, lofi…), baixo (808/punch/finger/upright), pad, pluck, arpejo e melodia com contorno.
5. **Voz** → cada linha da letra vira frase: sílabas (heurística de vogais) → notas do acorde → **síntese formântica** (fonte pulsada + 2 ressonadores por vogal), com vibrato, portamento e consoantes.
6. **Mixagem** → reverb (Schroeder), delay, limitador, normalização, fades. Se a opção **Lo-fi** estiver ligada, a camada de chuva entra aqui, antes da normalização.

Cada faixa guarda os metadados: BPM, tom, estrutura, progressão, vozes cantadas e picos de waveform para a UI.

### Tela "Criar" (inspirada no Suno)

```
[ Áudio ref. ]   [ + Voz ]
┌ Letra        [💡] ✨ ┐   [💡] lampada = gera a letra COMPLETA a partir do tema do campo
│  textarea           │   ✨ estrela = sorteia só um tema de 1 linha (sem letra)
│  toggle "Instrumental" dentro do bloco
└─────────────────────────┘
┌ Estilos          ✨ ┐   varinha = sorteia uma descrição de estilo aleatória
│  textarea + faixa do áudio de referência + chips de gênero + clima + voz
└─────────────────────────┘
┌ Mais opções          ┐
│  Variedade (0-100, com marcas e rótulo: Mínima→Máxima)
│  Duração · Título da música · Lo-fi
└─────────────────────────┘
              [ ✦ Criar ]
```

- **Variedade** (0–100) altera o arranjo no motor: densidade do arpejo, repetição da melodia, inversões de acorde e fills de bateria. 0 = parado e repetitivo, 100 = mais disperso (medido: 33% de diferença na forma de onda entre os extremos).
- **Sorteio (✨) e geração (💡)**: nos blocos **Estilos** e **Letra** os botões **sorteiam** itens de listas locais — 22 descrições de estilo ("Lo-fi chill com piano suave, chuva de fundo e textura de vinil") e 22 temas de letra ("Uma música sobre dirigir na estrada à noite"). No **Letra**, a **✨ estrela** escreve **só o tema** no campo e a **💡 lâmpada** é quem o transforma em letra completa (única a chamar a API). O campo acende com um brilho (`is-magic`) e dois cliques seguidos nunca repetem a mesma sugestão. O sorteio é offline: nada vai para a API (ver 4.0.4).
- **+ Voz** abre o seletor: **Automático** (IA se houver chave), **Voz por IA (OpenRouter)** ou **Voz procedural (local)**, com 10 vozes (alloy, coral, onyx, ash, echo, fable, shimmer, nova, sage, verse).
- **Áudio ref.** anexa um arquivo de áudio para a geração seguir o estilo/timbre dele (ver 4.0.1). O nome do arquivo aparece logo abaixo do campo de ideia, com botão para remover e o **seletor de modo**: *Estilo (Remix)* ou *Cover (Manter Melodia)* (ver 4.0.2).
- **Prioridade do estilo**: o **texto do campo "Estilos" manda sempre**. Quando ele está preenchido, os botões de gênero (Pop, MPB, …) são **ignorados** — ficam esmaecidos, não aceitam clique e o app avisa ("O texto digitado tem prioridade"). Só quando o texto está **vazio** o botão selecionado entra como fallback. A regra é garantida nos dois lados: o front-end manda `style` (o texto) e `genre` vazio, e o servidor ignora o gênero quando recebe o texto (`styleSource: "text"`).

---

## 4. Providers

A camada `server/providers/` alterna entre motor local e modelos remotos:

| Provider | Variável | Observação |
|---|---|---|
| **`acestep` (padrão)** | `ACESTEP_API_KEY` | **ACE-Step 1.5** (API oficial do ACE Music, `acemusic.ai`) — **gratuita**. Gera música, letra e vocal em uma chamada. |
| `local` | — | Motor próprio, offline, sem chave (fallback procedural). |
| `replicate` | `REPLICATE_API_TOKEN` | Modelo padrão `minimax/music-01` (música com vocal). |
| `fal` | `FAL_KEY` | Modelo padrão `fal-ai/minimax-music-01`. |
| `openai` (letras) | `OPENAI_API_KEY` | Letra completa via `gpt-4o-mini`. |

A seleção é automática: **com `ACESTEP_API_KEY` o ACE-Step é o motor padrão**; sem chave (ou se a chamada remota falhar) o app cai no motor local procedural. Para forçar:

```bash
MUSICGPT_MUSIC_PROVIDER=acestep  # ou local | replicate | fal
MUSICGPT_LYRICS_PROVIDER=openai  # ou local
```

> O provider local **canta** de forma sintética (formantes). É um placeholder honesto de voz, não um vocal de modelo neural. Com o ACE-Step, a faixa passa a ter o **vocal real do modelo**, com o arranjo, a mixagem e a letra feitos pelo ACE-Step.

---

## 4.0 ACE-Step 1.5 (motor padrão — `acemusic.ai`)

Motor oficial do [ACE-Step](https://github.com/ace-step/ACE-Step-1.5), servido pela API do [ACE Music](https://acemusic.ai). A chave é **gratuita**:

```bash
# 1) pegue a chave em https://acemusic.ai/api-key
# 2) cole no .env da raiz do projeto:
ACESTEP_API_KEY=sk-...
```

### Como funciona (`server/providers/acestep.js`)

1. `POST https://api.acemusic.ai/v1/chat/completions` com `Authorization: Bearer <chave>`.
2. Corpo no formato do ACE-Step (compatível com OpenAI):

```json
{
  "model": "acemusic/acestep-v1.5-turbo",
  "messages": [{ "role": "user", "content": "<prompt>MPB melancólica, about 69 seconds</prompt><lyrics>[Verse 1]…</lyrics>" }],
  "stream": false,
  "thinking": true,
  "use_format": false,
  "audio_config": { "format": "mp3", "instrumental": false, "duration": 69, "vocal_language": "pt" }
}
```

- **caption**: o prompt de estilo (descrição do app + gênero + clima + lo-fi/instrumental) vai dentro de `<prompt>`. **Quando o texto do campo "Estilos" está preenchido, ele é a caption**: o gênero do botão não é acrescentado (não aparece `"Pop style"` junto do texto do usuário) — só sem texto o gênero entra como fallback.
- **letra**: vai dentro de `<lyrics>`. Sem letra do usuário, o pedido usa `sample_mode: true` e o **próprio LM 5Hz escreve a letra** — a letra volta no campo `content` (`## Lyrics`) e é guardada na faixa.
- **`thinking: true`**: liga o **LM 5Hz**, que gera os códigos semânticos antes do DiT — é o modo de **maior qualidade** (o `thinking: false` faz o DiT rodar em modo text2music, sem os códigos do LM).
- **`vocal_language`**: vem do idioma do app (`pt`/`en`). Sem isso o LM canta em inglês mesmo com prompt em português (medido: `"Language: en"` → com `pt`, `"Language: pt"` e letra em português).
- **resposta**: `choices[0].message.audio[0].audio_url.url` = `data:audio/mpeg;base64,…`.

3. O base64 é **decodificado**, salvo em `data/tracks/<id>.mp3` e devolvido com o **caminho local** — o player usa a rota `/api/tracks/:id/audio` (com suporte a `Range`), igual às faixas do motor local. A `audio_url` original (a própria data URL) também fica guardada em `track.sourceUrl`, para que o **download não dependa do disco** na nuvem (ver 5.2).
4. BPM, tom e duração são lidos dos metadados que o LM escreveu (`**BPM:**`, `**Key:**`, `**Duration:**`) e exibidos no card da faixa.

### Duração: o host entrega ~43% do tempo planejado

Medido na API hospedada: pedir 30 s → 13 s · 60 s → 26 s · 120 s → 51 s · 240 s → 102 s (teto de ~100 s). O modelo **planeja** a faixa e o host renderiza só uma parte dela.

Por isso o app pede ao modelo um tempo **2,3× maior** que o alvo (o mesmo fator vai na dica de duração do caption, porque no modo *sample* o LM ignora o campo `duration` e planeja a partir do texto). Resultado real medido: **pedido 30 s → 30,6 s de faixa**.

Ajuste o fator em `ACESTEP_DURATION_FACTOR` (1 = sem compensação). A duração **real** é sempre medida do MP3 gerado e é a que aparece no app.

### Metadados

- No modo **sample** (sem letra do usuário) o LM devolve `## Metadata` com caption, BPM, tom, duração, idioma e a letra que escreveu — tudo é salvo na faixa.
- No modo **tag** (letra enviada pelo usuário) o host não devolve metadados do LM (`"Music generated successfully."`): o BPM exibido vem do gênero escolhido e o tom fica vazio. O áudio é o mesmo, com `thinking: true` ativo.

### Variáveis

| Variável | Padrão | O que faz |
|---|---|---|
| `ACESTEP_API_KEY` | — | Chave da API (obrigatória para usar o ACE-Step). |
| `ACESTEP_BASE_URL` | `https://api.acemusic.ai/v1` | Base da API. |
| `ACESTEP_MODEL` | vazio (o servidor escolhe) | Modelo do DiT. O host expõe `acemusic/acestep-v1.5-turbo` (`GET /v1/models`). |
| `ACESTEP_THINKING` | `1` | `1` = usa o LM 5Hz (qualidade); `0` = desliga. |
| `ACESTEP_VOCAL_LANGUAGE` | vazio (usa o idioma do app) | Idioma do vocal (`en`, `pt`, `zh`, `ja`…). |
| `ACESTEP_DURATION_FACTOR` | `2.3` | Compensação da duração (ver acima). |
| `ACESTEP_REFERENCE_STRENGTH` | `0.3` | Peso do áudio de referência na geração (ver 4.0.1). |
| `ACESTEP_COVER_STRENGTH` | `0.98` | Peso do áudio de origem no modo **cover** — quanto maior, mais perto da melodia original (ver 4.0.2). |
| `ACESTEP_COVER_NOISE_STRENGTH` | `0.7` | Âncora no áudio original no cover (`0` = ruído puro, `1` = colado no original). É o parâmetro que mais pesa na fidelidade. |
| `ACESTEP_TIMEOUT_MS` | `600000` | Timeout da geração. |
| `MUSICGPT_MAX_REFERENCE_BYTES` | `15728640` (15 MB) | Tamanho máximo do áudio de referência enviado pelo app. |

### Fallbacks (o app nunca quebra)

| Falha | Comportamento |
|---|---|
| Sem `ACESTEP_API_KEY` (ou chave ainda no formato de exemplo) | motor **procedural local** + letra local — o app funciona offline |
| ACE-Step responde erro (cota, rede, chave inválida) | a faixa é **re-renderizada pelo motor procedural** e o aviso aparece no card de resultado |
| `ACESTEP_MODEL` rejeitado pelo servidor | nova tentativa com os modelos alternativos (`acestep-v15-xl-turbo`, `acestep-v15-turbo`, `acemusic/acestep-v15-turbo`) |

> O `ACESTEP_API_KEY=sua_chave_aqui` deixado no `.env` é tratado como **"não configurado"** — o app cai no motor procedural até você colar a chave real.

### 4.0.1 Áudio de referência (Audio-to-Audio / Style Transfer)

Anexe um arquivo de áudio e a música nova nasce **com o estilo do arquivo**: mesmo timbre, mesma instrumentação, mesma produção — mas com a letra, a melodia e a estrutura pedidas no prompt.

**Na interface (tela *Criar*)**

1. O botão **"Áudio ref."** (no topo do painel, ao lado de "Voz") abre o seletor de arquivos (`<input type="file" accept="audio/*">` escondido).
2. Escolhido o arquivo, o **nome e o tamanho** aparecem numa faixa roxa logo abaixo do campo de ideia, com um botão **✕** para remover.
3. Na mesma faixa aparece o **seletor de modo** (ver 4.0.2): *Estilo (Remix)* ou *Cover (Manter Melodia)*.
4. Ao tocar em **Criar**, o app envia o pedido em `multipart/form-data` (o arquivo no campo `referenceAudio` + o campo `audioMode`); sem arquivo, continua enviando JSON — o fluxo "gerar do zero" **não muda**.

**No servidor**

| Camada | O que faz |
|---|---|
| `server/upload.js` | Lê o `multipart/form-data` com **multer** (`memoryStorage`, limite de 15 MB, só arquivos de áudio) e devolve `{ fields, file }`. |
| `server/api.js` | A rota `POST /api/generate` aceita **JSON ou multipart** (os campos de texto do multipart chegam como string e são normalizados — `instrumental: "false"` não vira `true`). |
| `server/audio/reference.js` | Descobre o formato do arquivo (MIME/extensão: mp3, wav, ogg, m4a, aac, flac, webm, aiff) e monta o payload base64. |
| `server/providers/acestep.js` | Monta a mensagem **multimodal** e envia para a API do ACE-Step. |

**O pedido para o ACE-Step**

```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<prompt>MPB melancólica, about 69 seconds</prompt>" },
      { "type": "input_audio", "input_audio": { "data": "<base64 do arquivo>", "format": "wav" } }
    ]
  }],
  "task_type": "text2music",
  "audio_cover_strength": 0.3,
  "audio_config": { "format": "mp3", "instrumental": false, "duration": 69 }
}
```

- Com `task_type: "text2music"` o áudio enviado vira a **referência de estilo** (a API encaminha o primeiro bloco `input_audio` para `reference_audio`).
- `audio_cover_strength` é o quanto a referência pesa: `0` = ignora o estilo do arquivo, `1` = segue o áudio de perto. A documentação do ACE-Step recomenda `0.2` para transferência de estilo pura; o app usa `0.3` (`ACESTEP_REFERENCE_STRENGTH`).

**Fallbacks**

| Situação | Comportamento |
|---|---|
| Sem arquivo anexado | fluxo normal (JSON), geração do zero — **inalterado**. |
| Motor local (sem chave do ACE-Step) | a faixa é gerada sem referência e o card mostra o aviso "Áudio de referência ignorado: ele precisa do motor ACE-Step…". |
| API recusa o arquivo (400/413/415/422) | nova tentativa **sem** a referência (a faixa não se perde) e a faixa fica marcada com `used: false`. |
| Arquivo que não é áudio (ou grande demais) | `400` com mensagem clara; o app mostra o erro e não manda a geração. |

**Teste**

```bash
npm run test:referencia              # sobe o próprio servidor (motor local) e confere o fluxo todo
MUSICGPT_TESTE_LIVE=1 npm run test:referencia   # gera de verdade no ACE-Step com áudio de referência
```

### 4.0.2 Estilo (Remix) x Cover (Manter Melodia)

O mesmo áudio anexado pode ser usado de **duas maneiras**, escolhidas no seletor que aparece na faixa do arquivo:

| Modo | O que o arquivo é | Efeito |
|---|---|---|
| **Estilo (Remix)** (padrão) | `reference_audio` — só referência de estilo/timbre | A música nova é outra: mesmo timbre/instrumentação/produção, melodia e letra novas. (`task_type: "text2music"`, `audio_cover_strength: 0.3`) |
| **Cover (Manter Melodia)** | `src_audio` — o **áudio de origem** | O modelo tenta manter a melodia e a estrutura do original, trocando o resto pelo prompt. (`task_type: "cover"`, `audio_cover_strength: 0.98`, `cover_noise_strength: 0.7`) |

**Fidelidade ao Original** (slider, só no modo cover)

O cover não é uma cópia: o ACE-Step **re-sintetiza** a faixa a partir do áudio de origem. O quanto ela gruda no original depende de dois parâmetros:

| Parâmetro | O que faz | Padrão |
|---|---|---|
| `audio_cover_strength` | força da referência de melodia/códigos (`0.8`–`1.0` no slider) | `0.98` |
| `cover_noise_strength` | âncora no áudio original (`0` = ruído puro, `1` = colado no original) | `0.7` |

O slider **"Fidelidade ao Original"** (80%–100%) aparece só no modo cover e controla o `audio_cover_strength`. O `cover_noise_strength` fica no servidor (`ACESTEP_COVER_NOISE_STRENGTH`).

> **Medido** no áudio "Modern Talking" (30 s, mesma seed e mesmo prompt em todas as variações, `npm run test:fidelidade`):
>
> | Cover | melodia | nota dominante igual |
> |---|---|---|
> | faixa **sem relação** com o original (controle) | 0.58–0.74 | 0.08–0.35 |
> | `audio_cover_strength: 0.85` sem `cover_noise_strength` (config antiga) | 0.71 | 0.27 |
> | `audio_cover_strength: 0.98` **sem** `cover_noise_strength` | 0.73 | 0.30 |
> | `audio_cover_strength: 0.85` + `cover_noise_strength: 0.7` | 0.77 | 0.38 |
> | `audio_cover_strength: 1.00` + `cover_noise_strength: 0.7` (padrão novo) | 0.77 | 0.38–0.39 |
>
> Ou seja: o `cover_noise_strength` é o parâmetro que mais pesa — a config antiga deixava a melodia no mesmo nível de uma faixa qualquer; com ele, o cover sai claramente acima da faixa aleatória. Ainda assim **não é cópia**: o ACE-Step re-sintetiza a faixa, então nota dominante ~0.39 é o teto prático (1.0 = cópia idêntica).

**Na interface**

1. Anexe o arquivo (botão **"Áudio ref."**) — a faixa roxa mostra nome, tamanho e o seletor de modo.
2. Escolha o modo (radio buttons): *Estilo (Remix)* ou *Cover (Manter Melodia)*.
3. O modo vai no pedido (`audioMode`) e aparece no card da faixa gerada: tag **`modo: estilo`** ou **`modo: cover`**.

**Como o arquivo chega na API**

O arquivo vai no bloco multimodal `input_audio` da mensagem. **Quem decide para onde ele é encaminhado é o `task_type`** (documentação do ACE-Step, *Audio Routing Rules*):

| `task_type` | `audio[0]` | `audio[1]` |
|---|---|---|
| `text2music` | `reference_audio` (referência de estilo) | — |
| `cover` / `repaint` / `lego` / `extract` / `complete` | **`src_audio`** (áudio a ser editado) | `reference_audio` (opcional) |

No modo cover o pedido sai assim:

```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<prompt>rock anos 90 com guitarra pesada</prompt>" },
      { "type": "input_audio", "input_audio": { "data": "<base64 do arquivo>", "format": "wav" } }
    ]
  }],
  "task_type": "cover",
  "audio_cover_strength": 0.98,
  "cover_noise_strength": 0.7,
  "thinking": false,
  "audio_config": { "format": "mp3", "instrumental": false, "duration": 69 }
}
```

> `cover_noise_strength` é do ACE-Step 1.5: *"Cover noise blending strength (0.0=pure noise, 1.0=closest to source audio). Used for cover/repaint tasks."* — é ele que ancora a geração no áudio original.

> O bloco `input_audio` é obrigatório no cover: sem ele a API responde `400` ("Task 'cover' requires source audio"). É por isso que o arquivo **não** vai num campo solto (`src_audio`) no corpo JSON — o endpoint compatível com OpenAI ignora esse campo e exige o bloco multimodal (verificado contra a API hospedada).

Duas diferenças do cover no provider (`server/providers/acestep.js`): o **LM 5Hz é desligado** (`thinking: false`, porque a API pula o LM em tarefas de edição) e o **sample mode é desativado** (a letra nova não é inventada pelo LM — brigaria com a melodia original).

**Teste**

```bash
npm run test:modo                    # contrato + HTTP + navegador (Chromium headless, motor local)
MUSICGPT_TESTE_LIVE=1 npm run test:modo   # gera de verdade no ACE-Step no modo cover
npm run test:fidelidade -- <original> <cover>   # mede a fidelidade do cover (melodia/escala/ritmo)
```

O teste confere o `task_type`/`audio_cover_strength` de cada modo, a rota HTTP (`audioMode` + tag), o seletor na interface, o card com a tag do modo e o **layout mobile** (sem overflow, seletor visível e clicável).

### 4.0.3 Prioridade do texto de Estilos sobre os botões de gênero

O **texto** do bloco "Estilos" tem prioridade **absoluta** sobre os botões de gênero (Pop, MPB, …).

| Camada | O que garante |
|---|---|
| `public/app.js` | `resolveStyleSelection()`: com texto → `style` = texto e `genre` = vazio; sem texto → `genre` = botão selecionado (fallback). `syncStylePriority()` esmaece os chips e mostra o aviso "O texto digitado tem prioridade" enquanto o texto existe. |
| `server/api.js` | `POST /api/generate`: quando chega `style` (o texto), o gênero do botão é ignorado (`styleSource: "text"`) e a faixa guarda `style`/`styleLabel`/`tags[0]` = o texto digitado. Sem texto, o gênero manda (`styleSource: "genre"`). |
| `server/providers/acestep.js` | `buildCaption()`: com o texto, a caption **não** ganha o sufixo do gênero (não aparece `"Pop style"` junto do que o usuário escreveu). Sem texto, o gênero entra como fallback. |

**Teste**

```bash
npm run test:estilo                  # contrato + HTTP + navegador (Chromium headless, motor local)
MUSICGPT_TESTE_LIVE=1 npm run test:estilo   # gera de verdade no ACE-Step com áudio de referência
```

O teste do navegador anexa um áudio de referência, digita `Modern talking, cherry cherry lady` no
campo de estilo, clica em **Criar** e confere o card: a tag `ref: <arquivo>` aparece, a tag com o
**texto exato** digitado aparece e o `"Pop"` do botão **não** aparece.

### 4.0.4 Varinha mágica: sorteia estilo/tema e **gera** letra

Os dois blocos da tela "Criar" têm botões de mágica (💡 e ✨):

| Bloco | Botão | O que faz |
|---|---|---|
| **Estilos** | `#btnStyleWand` | Sorteia uma das **22 descrições de estilo** (`STYLE_SUGGESTIONS`) e preenche o campo de ideia (offline, sem request). Como o texto passa a existir, `syncStylePriority()` entra em ação: os chips de gênero ficam esmaecidos e o aviso "O texto digitado tem prioridade" aparece (ver 4.0.3). |
| **Letra** | `#btnLyricAI` (💡) | Lê o **texto atual do campo** (o tema) e chama `POST /api/lyrics` para **gerar a letra completa** — é o **único** botão do bloco que chama a API. Sem texto no campo, ela sorteia um dos **22 temas** (`LYRIC_THEMES`) e gera a partir dele. O bloco é reaberto e o campo ganha o efeito `is-magic`. |
| **Letra** | `#btnLyricWand` (✨) | **Sorteia apenas um tema curto** (uma frase de 1 linha, ex.: "Uma música sobre a saudade da infância na praia") entre os **22 temas** (`LYRIC_THEMES`) e escreve **só isso** no campo — **não** gera verso/refrão e **não** chama a API. O tema é a semente que a lâmpada 💡 ao lado transforma em letra completa. |

Regras do sorteio de estilo e de tema (`public/app.js`):

- **Zero rede.** As listas vivem no front-end (`STYLE_SUGGESTIONS` e `LYRIC_THEMES`); nenhum request é feito. É por isso que funciona offline e não gasta cota de API.
- **Sem repetição.** `pickRandom(lista, valorAtual)` remove o valor que já está no campo antes de sortear — dois cliques seguidos **nunca** devolvem a mesma sugestão (verificado no teste, nos dois botões).
- **Só o tema, nunca a letra.** A ✨ estrela escreve uma linha única, sem tags de seção — o teste garante que a letra completa anterior é substituída pelo tema e que nenhuma chamada a `/api/lyrics` acontece nesse clique.
- **Blindagem (`temaCurto()`).** Antes de escrever no campo, o item sorteado passa por `temaCurto(texto)`: pula linhas que são só tag (`[Verse 1]`) e remove uma tag embutida no início (`[Chorus] amor na rua` → `amor na rua`). Mesmo que um item da lista venha errado (multiplas linhas / estrutura de música), o campo **nunca** recebe Verso/Refrão por este caminho — o teste injeta um item corrompido na lista e confere (seção 4.1 do `testar-varinha`).

Regras da geração de letra (da lâmpada 💡, em `gerarLetra()`):

- **Seed nova por clique.** O gerador local deriva a seed do `hash(prompt)`; sem seed explícita, o **mesmo tema devolveria sempre a mesma letra**. Por isso o front manda `seed: Math.floor(Math.random() * 2**31)` a cada clique — mesma seed ainda dá a mesma letra (determinismo preservado).
- **Estilo junto.** O texto de Estilos vai como `style`, então o gerador sabe o gênero ("Genero: …") sem precisar adivinhar.
- **Nunca quebra.** Se o provider de IA falhar, o backend cai no gerador local offline (ver 4.1).
- **Efeito visual.** `magicEffect(campo, botão)` adiciona a classe `is-magic`: `@keyframes magicGlow` (brilho roxo + fade no textarea) e `@keyframes magicSpin` (sacudida no botão). A classe sai no `animationend` (ou após 1,2 s), então o efeito se repete em cliques seguidos. Com `prefers-reduced-motion: reduce` a animação vira um anel fixo.

**Teste**

```bash
npm run test:varinha                # navegador headless (Chromium), motor local, 35 verificações
```

O teste confere as duas listas (≥ 15 itens cada) e que **todos os temas da lista da ✨ são frases de 1 linha, sem `[tags]`**; que a varinha de **Estilos** preenche o campo com um item **da lista** sem repetir, que a animação `is-magic` dispara no campo e nos dois botões do bloco, que os chips de gênero ficam desativados (prioridade do texto), que a **💡 lâmpada gera** letra completa (com tags de seção) a partir do tema digitado — e que dois cliques com o mesmo tema dão letras diferentes —, que a **✨ estrela só sorteia um tema** de 1 linha (item da lista, sem tags de seção, **sem chamar `/api/lyrics`**), que **dois cliques seguidos dela não repetem o tema**, que depois a 💡 **transforma aquele tema em letra completa e é ela quem faz a chamada à API** (contagem de requests), que **um item corrompido na lista não vaza estrutura de música para o campo** (blindagem `temaCurto()`), que o bloco "Letra" é reaberto e que o layout **mobile** (390 px) segue sem overflow.

---

### 4.0.5 Tema no campo "Letra" vira letra completa antes de virar áudio

O campo "Letra" aceita as duas coisas — a própria letra **ou** uma sugestão/tema (o placeholder diz "Escreva a letra de uma música **ou uma sugestão**", e o botão ✨ escreve exatamente um tema ali). Mas **um tema não é uma letra**: era enviado ao motor como se fosse, e o resultado era a mesma frase cantada em todas as frases (medido: **16 frases idênticas** na mesma faixa).

A correção fica em `server/lyrics.js` + `server/api.js`:

| Camada | O que faz |
|---|---|
| `server/lyrics.js` | `isCompleteLyric(texto)` separa **letra** de **tema**: 2+ tags de seção, ou 1 tag com conteúdo, ou 4+ linhas sem tag ⇒ letra; 1–3 linhas sem tag ⇒ tema. `lyricTheme(texto)` devolve o tema (ou vazio se já for letra). |
| `server/api.js` (`executeJob`) | Antes de chamar o motor, `lyricTheme(lyrics)` detecta o caso e **expande o tema em letra completa** via `generateLyricsWithProvider()` (IA quando há chave, senão gerador local). O tema original fica guardado em `track.lyricsTheme` e `track.lyricsExpanded: true`, e um warning "Tema expandido em letra completa." vai junto (a UI mostra em **info**, não como erro). |

Garantias (todas verificadas pelo teste):

- Tema ⇒ letra completa com tags e **vocais cantando linhas diferentes**.
- **Sem letra** ⇒ o motor continua escrevendo a própria (`acestep-lm` / local), como antes.
- **Letra completa escrita pelo usuário** ⇒ é respeitada **como está**, nunca reescrita.
- **Instrumental** ⇒ o tema não vira letra nem gera vocal.
- Com **ACE-Step** ativo, a letra expandida é a que vai dentro de `<lyrics>` na caption (o `lyricsEngine` do gerador prevalece sobre o `user`).

**Teste**

```bash
npm run test:letra                  # contrato + HTTP + navegador (Chromium), 37 verificações
```

---

## 4.1 IA real via OpenRouter (letra + voz) — opcional

O app **não depende** do OpenRouter para gerar música: quem faz isso é o ACE-Step. O OpenRouter continua disponível em dois pontos:

1. **Lâmpada 💡 do bloco Letra** (`POST /api/lyrics`, id `#btnLyricAI`) — usa `openai/gpt-4o-mini` quando há chave: ela manda o **tema do campo** e recebe a letra completa, com uma seed nova por clique (senão o gerador local devolveria sempre a mesma letra). O botão ✨ (`#btnLyricWand`) **não passa pela API**: ele só sorteia um tema da lista local (ver 4.0.4). Se a chamada da 💡 falhar (sem chave, sem crédito 402, sem rede), a própria rota **cai no gerador local offline** e devolve 200 — nunca 502.
2. **TTS** — só no motor local e **apenas** se você escolher "Voz por IA (OpenRouter)" na interface (ou `MUSICGPT_TTS_PROVIDER=openrouter`).

Quando a chave está em `.env`:

```bash
# .env na raiz
OPENROUTER_API_KEY=sk-or-v1-...
```

| Parte | Endpoint | Modelo padrão (validado) |
|---|---|---|
| Letra | `POST /api/v1/chat/completions` | `openai/gpt-4o-mini` (alternativa: `anthropic/claude-haiku-4.5`) — **exige crédito** |
| Voz | `POST /api/v1/audio/speech` | **`fish-audio/s2.1-pro-free:free`** — **gratuito, funciona sem crédito** (testado: HTTP 200, MP3 de 3,8 s) |

> **Atenção:** `openai/gpt-4o-mini-tts` **não existe** no OpenRouter (retorna 400). Os modelos acima foram testados no endpoint de TTS.
>
> O modelo **free** de voz não precisa de saldo na conta — então a voz por IA já funciona mesmo sem créditos. Só a **letra** (chat) ainda cai no gerador local enquanto a conta estiver sem saldo (a faixa sai com aviso no card). Para trocar para a variante paga: `OPENROUTER_TTS_MODEL=fish-audio/s2.1-pro`.

**Fluxo de uma geração com voz (motor local + TTS):**

1. Letra pelo gerador local (ou pelo chat do OpenRouter, se `MUSICGPT_LYRICS_PROVIDER=openrouter`).
2. O motor procedural renderiza **só o instrumental** (worker thread).
3. Cada seção da letra (`[Verse 1]`, `[Chorus]`…) é sintetizada **separadamente** pelo TTS e posicionada no compasso correspondente da estrutura — assim a fala cai junto do verso/refrão.
4. O MP3 do TTS é decodificado (wasm `mpg123`), reamostrado e **misturado** no WAV do instrumental (ganho 1,15 + limitador para não estourar o pico de 0,9 do instrumental).
5. O WAV resultante é o master da faixa (e o MP3 sai do cache sob demanda).

### Fallbacks (o app nunca quebra)

| Falha | Comportamento |
|---|---|
| Sem `OPENROUTER_API_KEY` no `.env` | letra pelo gerador local + voz procedural (o motor de sempre) |
| OpenRouter sem crédito (402) ou erro | idem: a faixa é gerada e o aviso aparece no card de resultado |
| TTS falha mas a letra veio da IA | re-renderiza com a **voz procedural** e avisa |

### Da fala ao canto

O endpoint `/audio/speech` **ignora** `style`/`emotion` (verificado: valores inválidos também devolvem 200 e o áudio não muda), então o canto é feito **localmente**:

- `server/audio/singing.js` implementa **PSOLA (TD-PSOLA)** — os segmentos originais da voz são reaproveitados e reposicionados, o que **preserva os formantes** (não vira chipmunk).
- A voz passa a seguir o **contorno da melodia** da faixa (a mesma linha melódica que a voz procedural canta), na própria faixa da voz, com glissando entre notas.
- Medido: erro de **0,02 semitons** no pitch shift, duração preservada, voz variando de 150 Hz (fala) para 158→160→166 Hz acompanhando as notas 61→57→58→56 da melodia.
- Controle na interface: **+ Voz → "Cantar sobre a melodia" (0–100%)**; em 0% a voz só fala.

> Observação: `fish-audio/s1-free` **não existe** no OpenRouter (400). Os modelos válidos em `/audio/speech` são `fish-audio/s2.1-pro-free:free` (gratuito), `fish-audio/s2.1-pro`, `fish-audio/s2-pro`, `fish-audio/s1` e `hexgrad/Kokoro-82M`.
>
> O modelo **free** não exige crédito, mas tem **cota diária** ("free models per day"). Ao estourar, a API devolve 429 e o app volta para a voz procedural. Adicionar **10 credits** na conta libera 1000 requisições/dia.

Cada faixa guarda `lyricsEngine` e `voiceInfo` (engine, modelo, voz, nº de takes) — visíveis na interface como **"voz IA"**.

Variáveis: `OPENROUTER_LYRICS_MODEL`, `OPENROUTER_TTS_MODEL`, `OPENROUTER_TTS_VOICE`, `OPENROUTER_TTS_PER_SECTION=0` (uma chamada só com a letra inteira), `OPENROUTER_BASE_URL`.

---

| Método | Rota | Função |
|---|---|---|
| `GET` | `/api/health` | estado do servidor e providers ativos |
| `GET` | `/api/config` | gêneros, climas, vozes, providers |
| `POST` | `/api/generate` | cria um job → `{ jobId }` (JSON **ou** `multipart/form-data` com o campo `referenceAudio`) |
| `GET` | `/api/jobs/:id` | status do job |
| `GET` | `/api/jobs/:id/events` | **SSE** com progresso em tempo real |
| `POST` | `/api/lyrics` | `{ mode: 'full' \| 'next' }` → letra ou próxima linha |
| `GET` | `/api/tracks` | biblioteca |
| `GET` | `/api/tracks/:id` | detalhe |
| `DELETE` | `/api/tracks/:id` | exclui faixa e arquivo |
| `POST` | `/api/tracks/:id/play` | conta play |
| `POST` | `/api/tracks/:id/publish` | publica/despublica na comunidade |
| `GET` | `/api/tracks/:id/audio?format=wav\|mp3&download=1` | stream com **Range** ou download (cai para a URL original se o disco sumiu) |
| `GET` | `/api/download/:id?format=wav\|mp3&source=auto\|remote\|local` | **download do áudio** (`Content-Disposition: attachment`), sem depender do disco (ver 5.2) |
| `GET` | `/api/tracks/:id/share` | payload de compartilhamento |
| `GET/POST` | `/api/playlists` | lista / cria |
| `PATCH/DELETE` | `/api/playlists/:id` | edita / exclui |
| `GET/PUT` | `/api/profile` | perfil e modelo criativo |
| `GET` | `/api/explore` | ideias da comunidade + faixas publicadas |

Exemplo:

```bash
curl -X POST localhost:8787/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"MPB melancólico sobre saudade de uma casa antiga","duration":60}'
```

Com áudio de referência (Audio-to-Audio / Style Transfer):

```bash
curl -X POST localhost:8787/api/generate \
  -F 'prompt=MPB melancólico no mesmo timbre da referência' \
  -F 'duration=60' \
  -F 'referenceAudio=@minha-musica.mp3'
```

---

## 6. Rodando

```bash
cd musicgpt
npm install          # só o encoder de MP3
npm start            # porta 8787 (PORT=xxxx para trocar)
npm run dev          # com --watch
npm test             # testes locais (referência + estilo + varinha + letra + modo do áudio + espectro + download) - servidor precisa estar no ar
```

Variáveis úteis: `PORT`, `HOST`, `MUSICGPT_DATA_DIR`, `MUSICGPT_MUSIC_PROVIDER`, `MUSICGPT_LYRICS_PROVIDER`, `MUSICGPT_TTS_PROVIDER`, `ACESTEP_API_KEY`, `ACESTEP_BASE_URL`, `ACESTEP_MODEL`, `ACESTEP_THINKING`, `ACESTEP_VOCAL_LANGUAGE`, `ACESTEP_DURATION_FACTOR`, `ACESTEP_REFERENCE_STRENGTH`, `ACESTEP_TIMEOUT_MS`, `MUSICGPT_MAX_REFERENCE_BYTES`, `REPLICATE_API_TOKEN`, `FAL_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MUSICGPT_SSL_CERT`, `MUSICGPT_SSL_KEY`.

### Porta

`server/index.js` resolve a porta assim: **`process.env.PORT` tem prioridade** (é o que Render/Heroku/Docker injetam) e, sem a variável — ou com valor inválido (`0`, `-1`, `abc`) — o app cai na **porta 8787**. O helper fica em `server/config.js` (`resolvePort()`/`DEFAULT_PORT`).

```bash
PORT=3000 npm start     # sobe em http://localhost:3000
```

---

## 6.0 Deploy no Render

O `render.yaml` da raiz já está pronto (Blueprint):

```yaml
services:
  - type: web
    name: musicgpt
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
```

O que funciona bem no Render:

- **Porta**: o Render injeta `PORT` e o app lê essa variável (fallback 8787) — nada a configurar.
- **Bind**: o servidor escuta em `0.0.0.0` (`HOST`), como o Render espera.
- **Start**: `npm start` → `node server/index.js` (sem build step, sem bundler).

O que precisa de atenção:

| Item | Orientação |
|---|---|
| **Chaves** | o `.env` está no `.gitignore` e **não vai para o Render**. Cadastre `ACESTEP_API_KEY` (e, se quiser, `OPENROUTER_API_KEY`) em **Environment** no painel do Render. |
| **Dados** | `data/` (biblioteca, faixas) fica no disco efêmero do plano free: as faixas somem no próximo deploy. Para persistir, use um disco (`/mnt/data`) e aponte `MUSICGPT_DATA_DIR=/mnt/data`. Mesmo sem disco, o **download** e a **reprodução** continuam funcionando enquanto a faixa tiver a URL original do provider (ver 5.2). |
| **Frio** | o plano free hiberna após inatividade: a primeira requisição demora (e uma geração do ACE-Step leva ~30 s). |
| **Timeout** | geração longa → o proxy do Render pode cortar a conexão; o app continua o job em background e a faixa aparece na biblioteca. |

> **Atenção:** a chave `env:` do blueprint é o nome que você pediu, mas o Render usa **`runtime:`** para declarar o runtime. Troque `env: node` → `runtime: node` para o blueprint passar na validação do Render.

---

## 6.1 PWA (instalar na tela inicial e usar offline)

O app é uma **PWA completa**: `public/manifest.json` + `public/service-worker.js` + ícones em `public/icons/`.

| Peça | Onde | O que faz |
|---|---|---|
| Manifest | `public/manifest.json` | `display: standalone`, ícone maskable, atalhos (Criar / Biblioteca / Letras) via `?view=` |
| Service worker | `public/service-worker.js` | precache do app shell, `stale-while-revalidate` nas APIs de leitura, cache oportunista do MP3 (24 faixas) para ouvir offline |
| Ícones | `public/icons/` | 32, 192, 512, 512 maskable e 180 (apple-touch), gerados do logo SVG |
| Botão instalar | sidebar (`#btnInstall`) | aparece no `beforeinstallprompt`; no iOS mostra as instruções manuais |
| Indicador offline | badge `OFFLINE` no chip do perfil | reflete `navigator.onLine` |

Estratégia de cache: shell e estáticos em **network-first** (o cache é a reserva para o caso offline — assim uma atualização do app chega na hora), navegação em **network-first** com fallback para o index em cache, `/api/config|tracks|playlists|profile|explore` em **stale-while-revalidate**, áudio WAV/download **nunca** em cache.

### ⚠️ Para instalar no celular é obrigatório HTTPS

O Chrome **não registra service worker** em origens HTTP não-locais (e bloqueia em certificado inválido). Como o servidor escuta em `0.0.0.0`, `http://192.168.x.x:8787` **não** instala.

**Opção A — túnel HTTPS com certificado válido (recomendado):**

```bash
cloudflared tunnel --url http://localhost:8787     # ou: ngrok http 8787
# tailscale serve --bg 8787                          # ou: tailscale serve 8787
```

Abra a URL `https://…` no celular, toque em **Instalar app** (ou menu ⋮ → Instalar app) e o MusicGPT entra na tela inicial, abrindo em tela cheia.

**Opção B — HTTPS local com certificado autoassinado:**

```bash
npm run cert -- 192.168.1.10     # gera data/ssl/{cert,key}.pem
MUSICGPT_SSL_CERT=data/ssl/cert.pem MUSICGPT_SSL_KEY=data/ssl/key.pem npm start
```

Isso serve HTTPS em `https://192.168.1.10:8787`, mas o certificado autoassinado **não é confiável**: o Chrome deixa navegar (aceitando o aviso) porém **bloqueia o registro do service worker**, então a instalação não conclui. Use a Opção A para instalar de verdade.

**Opção C — sem instalar, mas com o modo offline:** em `chrome://flags/#unsafely-treat-insecure-origin-as-secure` adicione `http://192.168.x.x:8787` como origem segura (só desktop).

Verificado no Chromium: SW `activated` com escopo `/`, 10 itens no precache, `controller` ativo, e com a rede cortada a página **recarrega completa** (CSS, 16 chips de gênero vindos do `/api/config` em cache) exibindo o badge **OFFLINE**.

---

## 7. Limites conhecidos

- A **comunidade** é local: "Explorar" lista ideias curadas (`data/community.json`) e as faixas que o próprio usuário publicou. Não há back-end compartilhado entre usuários.
- A **voz local** é síntese formântica — inteligível como frase, mas não é canto de artista. Com o ACE-Step (ou outro provider remoto), a faixa tem vocal real do modelo.
- O **gerador local de letras** é template-based: garante métrica, estrutura e concordância, mas não rhyme complexo nem semântica profunda. Com o ACE-Step, quem escreve a letra é o **LM 5Hz** (sample mode) ou o OpenRouter, se você religá-lo.
- Faixas em **WAV** ocupam ~10 MB/min no disco; o MP3 (~1,2 MB/min) é gerado sob demanda.
- Durações curtas (abaixo de ~25 s) ficam limitadas pela estrutura mínima (20 compassos), então o resultado é sempre um pouco mais longo que o pedido.
- O **áudio de referência** só tem efeito com o motor **ACE-Step** (é ele que sabe usar a referência de estilo). O motor procedural local ignora o arquivo e avisa no card da faixa. O arquivo não é cortado nem processado: vai inteiro em base64 no pedido (limite de 15 MB).
- O modo **cover** depende do ACE-Step também: sem ele o arquivo é ignorado e a faixa nasce do prompt (o card mostra o aviso). No cover a duração final acompanha a do **áudio de origem** (a API mantém a melodia e o comprimento do original) — o slider de duração vale para o estilo/remix.
