# Kopia Desk — Arquitectura del proyecto

## Qué hace la aplicación

Kopia Desk es una aplicación de escritorio Windows que realiza copias de seguridad
incrementales de carpetas locales hacia discos externos o USB. Compara el estado actual
de cada carpeta contra un manifiesto guardado en la sesión anterior, copia sólo lo que
cambió, y permite restaurar archivos que falten en el PC.

---

## Mapa del proyecto

```
Kopia_Desk_Beta_2/
├── main.js                  ← Proceso principal de Electron (Node.js, acceso total al SO)
├── preload.js                ← Puente seguro entre main y la interfaz
├── package.json               ← Nombre, versión, dependencias y scripts (npm start / npm run build)
├── package-lock.json           ← Versiones exactas instaladas (lo genera npm, no se edita a mano)
│
├── lib/
│   └── core.js                 ← Lógica de escaneo/hashing/rutas seguras, testeable sin Electron
│
├── renderer/                  ← Todo lo que el usuario ve y toca
│   ├── index.html               ← Estructura de la pantalla
│   ├── app.js                   ← Lógica de la interfaz (botones, escaneo, backup, restauración)
│   └── styles.css               ← Estilos visuales
│
├── assets/
│   └── Kopia_Desk_icon.png     ← Icono de la app (ventana, instalador, titlebar)
│
├── test/
│   └── core.test.js            ← Tests de lib/core.js (node --test)
│
├── docs/
│   ├── arquitectura.md          ← Este archivo
│   └── design-reference/        ← Mockup de referencia visual (no se integra tal cual, ver más abajo)
│
├── dist/                      ← Se genera al ejecutar `npm run build` (el instalador .exe); se puede
│                                  borrar y regenerar en cualquier momento, no guarda nada único
│
└── node_modules/              ← Dependencias instaladas por npm (no se toca a mano); sólo hay dos
                                   paquetes reales detrás de todo esto (electron y electron-builder,
                                   ambas de desarrollo), el resto son sus propias dependencias internas
```

## Por dónde empezar

Los tres archivos que hay que entender primero, en orden:

1. **`main.js`** corre con acceso total al sistema operativo (Node.js). Es el
   único archivo que lee, escribe, comprime o borra archivos de verdad.
2. **`preload.js`** es la lista exacta de lo que la interfaz puede pedirle a
   `main.js`. Si una función no está aquí, la interfaz no puede usarla — es la
   barrera de seguridad de Electron (`contextIsolation: true`).
3. **`renderer/app.js`** corre en la ventana (sin acceso a Node.js) y sólo puede
   hablar con `main.js` a través de lo que expone `preload.js` mediante
   `window.kopiaAPI`.

| Quiero... | Empieza por... |
|---|---|
| Entender qué pasa al escanear/copiar | más abajo, `renderer/app.js` → `scanAll()` / `backupAll()` |
| Entender cómo se lee/escribe el disco o se deduplica | más abajo, `main.js` |
| Ver la lista completa de canales IPC | más abajo, "Canales IPC expuestos" |
| Entender la seguridad (path traversal, journal, dedup) | más abajo, "Seguridad" |

---

## Descripción de cada archivo

### `main.js` — Proceso principal

Corre en Node.js con acceso completo al sistema operativo. Es el único que puede
leer/escribir archivos, ejecutar comandos, y abrir ventanas. La lógica de
escaneo, hashing, exclusiones, rutas seguras y detección de disco vive en
`lib/core.js` (ver más abajo); `main.js` sólo la importa y expone cada función
como canal IPC. De arriba a abajo, está organizado en bloques:

1. **Ventana y arranque** — `createWindow()` crea la ventana de Electron y
   carga `renderer/index.html`. Al cerrar la última ventana, la app se cierra
   (`window-all-closed`).
2. **`safePath()` / `safeBackupPath()` — la barrera anti path-traversal** —
   antes de escribir cualquier archivo en el disco de backup, revisan que la
   ruta final quede **dentro** de la carpeta destino (y, en el caso de
   `safeBackupPath`, específicamente dentro de `KopiaDesk_Backup/`). Sin esto,
   un nombre de archivo malicioso (`../../Windows/System32/algo`) podría
   escribir fuera del backup. Se usan en cada operación de escritura — y
   también para **revalidar** rutas de lectura que vuelven desde el renderer
   (ver `restore:copy-files` más abajo).
3. **Discos, carpetas rápidas y exclusiones** — `listDrives()` pregunta a
   PowerShell (`Get-Volume`) qué discos hay conectados y cuánto espacio libre
   tienen. `folders:quick-list` usa `app.getPath()` de Electron para resolver
   las carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música,
   Videos, Escritorio) y sólo devuelve las que realmente existen en el equipo.
   `DEFAULT_EXCLUDES` es la lista de patrones que se ignoran al escanear
   (`Thumbs.db`, `desktop.ini`, `node_modules`, `*.tmp`, etc.); el usuario
   puede sumar los suyos desde el campo de texto de "Opciones" en la interfaz,
   y `compileExcludePatterns()` los convierte en expresiones regulares una
   sola vez por escaneo. `scanDirectoryRecursive()` recorre una carpeta
   entera, salta lo excluido, y devuelve el "manifiesto" de esa carpeta en ese
   momento — usa E/S asíncrona (`fs.promises`) para no bloquear la ventana
   mientras escanea carpetas con muchos archivos.
4. **Hashing** — `hashFileAsync()` calcula el SHA-256 completo de un archivo
   (lento pero 100% preciso; sólo se usa si el usuario activa "Verificación
   profunda"). `quickHashFile()` es más barato: sólo lee los primeros y
   últimos 64 KB, y se usa por defecto cuando un archivo tiene el mismo tamaño
   pero distinta fecha de modificación, para no volver a copiar algo que en
   realidad no cambió de contenido.
5. **Manifiestos y rutas recordadas** — `manifest:load`/`manifest:save`
   guardan el estado de cada carpeta de origen en
   `.kopia-data/manifests/<carpeta>.json`, con una copia `.prev.json` del
   estado anterior antes de sobrescribir. `sources:remember`/
   `sources:known-paths` guardan en `.kopia-data/sources.json` qué ruta local
   corresponde a cada carpeta respaldada, para que restaurar no tenga que
   volver a preguntar dónde estaba cada cosa.
6. **Deduplicación por contenido** — `copyOneTask()` calcula el hash de cada
   archivo (si la deduplicación está activada), revisa si ya existe ese mismo
   contenido en `.kopia-data/content-index.json` y, si es así, crea un
   **hardlink** (`fs.link`) en vez de copiar los bytes de nuevo. Un mecanismo
   interno (`pendingWrites`) evita que dos archivos idénticos copiándose al
   mismo tiempo se pisen: el segundo espera al primero y se enlaza a él.
7. **Journal (registro de operaciones)** — antes de copiar un lote, se
   escribe un registro en `.kopia-data/journal/` con el estado de cada
   archivo (pendiente/hecho). Si la app se cierra de golpe (corte de luz,
   disco desconectado) a mitad de una copia grande, la próxima vez que se
   elija ese destino se detecta (`journal:peek`, que sólo mira sin borrar) y
   la interfaz pregunta al usuario antes de limpiar; al confirmar,
   `journal:check` borra los archivos que quedaron a medio escribir.
8. **Concurrencia adaptativa** — `detectDriveType()` le pregunta a PowerShell
   si el disco destino es SSD, HDD o qué tipo de conexión usa.
   `pickConcurrency()` decide con esa información cuántos archivos copiar en
   paralelo: más en SSD con archivos pequeños, menos en discos mecánicos.
9. **Copia, versiones, restauración** — `backup:copy-files` combina todo lo
   anterior: deduplica si se le pide, actualiza el journal, y reporta
   progreso en tiempo real. `backup:copy-versions` guarda una copia del
   archivo **anterior** (antes de sobrescribirlo) comprimida con gzip
   (`stream.pipeline`, para que los streams se cierren solos si algo falla a
   mitad de camino). `restore:scan` compara lo que hay en el backup contra lo
   que hay en el PC y lista lo que falta; también reporta (`lostFromBackup`)
   los archivos que figuran en el manifiesto pero ya no existen en el disco
   de backup. `restore:copy-files` trae los archivos faltantes de vuelta al
   PC — revalidando con `safeBackupPath` la ruta de origen que vuelve desde
   el renderer, no confiando en ella a ciegas.

> **Nota**: se implementó y luego se quitó un cifrado AES-256-GCM por archivo —
> no aportaba suficiente frente a cifrar el disco USB completo con una
> herramienta a nivel de sistema (BitLocker, por ejemplo). Queda como posible
> mejora futura si se retoma con ese enfoque.

**Canales IPC expuestos:**

| Canal | Qué hace |
|---|---|
| `drives:list` | Lista discos con espacio disponible |
| `dialog:select-folder` | Abre diálogo para elegir carpeta origen |
| `dialog:select-restore-target` | Abre diálogo para elegir destino de restauración |
| `config:default-excludes` | Devuelve los patrones de exclusión por defecto |
| `fs:scan-directory` | Escanea recursivamente una carpeta, aplicando exclusiones |
| `fs:hash-file` | Calcula SHA-256 completo de un archivo |
| `fs:quick-hash` | Calcula un hash rápido (cabecera+cola de 64 KB) para confirmar cambios reales |
| `manifest:load` | Carga el manifiesto de una carpeta de origen |
| `manifest:save` | Guarda el manifiesto con copia de seguridad de versión anterior |
| `folders:quick-list` | Devuelve las carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música, Videos, Escritorio) que existan en el equipo |
| `backup:plan-concurrency` | Detecta el tipo de disco (SSD/HDD/USB) y sugiere la concurrencia de copia |
| `backup:copy-files` | Copia lotes de archivos con progreso en tiempo real; soporta deduplicación; registra un journal por operación; oculta la carpeta `.kopia-data` al terminar |
| `backup:copy-versions` | Guarda versiones anteriores comprimidas con gzip |
| `journal:peek` | Informa si hay un backup interrumpido (y cuántos archivos parciales quedaron) sin borrar nada, para que la UI pida confirmación |
| `journal:check` | Limpia los archivos parciales de un backup interrumpido (se ejecuta cuando el usuario confirma el aviso) |
| `log:save` | Guarda un registro JSON de la operación |
| `restore:scan` | Compara manifiesto vs estado actual del PC (pestaña "Comparar"); también detecta archivos que figuran como respaldados pero ya no están en el disco de backup (`lostFromBackup`) |
| `restore:full-list` | Lista TODO el contenido de una carpeta del backup, sin comparar contra nada (pestaña "Restaurar") |
| `restore:copy-files` | Restaura archivos del backup al PC |
| `restore:list-sources` | Lista carpetas disponibles en el backup |
| `sources:remember` / `sources:known-paths` | Recuerda/consulta la ruta local de cada carpeta de origen para restaurar sin volver a preguntar |
| `settings:load` | Carga configuración del usuario |
| `settings:save` | Guarda configuración del usuario |
| `window:minimize` / `window:toggle-maximize` / `window:close` / `window:is-maximized` | Controles de la ventana sin marco (titlebar propia, sin controles nativos de Windows) |

> Nota: `hideFolder` ya no es un canal IPC separado — se invoca internamente
> desde `backup:copy-files` (ver `lib/core.js`) para ocultar `.kopia-data` al
> terminar la copia.

---

### `lib/core.js` — Lógica de escaneo/hashing/disco (testeable)

Módulo CommonJS sin dependencias de Electron, `require`-eable directamente
desde `node --test`. Contiene las funciones puras y de E/S reutilizadas por
`main.js`:

- `safeName`, `safePath`, `safeBackupPath` — sanitización de nombres y
  protección contra path traversal.
- `compileExcludePatterns`, `isExcluded`, `DEFAULT_EXCLUDES` — filtros de
  exclusión.
- `scanDirectoryRecursive` — escaneo recursivo de carpetas. Usa `fs.promises`
  (E/S asíncrona) en vez de `fs.readdirSync`/`statSync`, para no bloquear el
  proceso principal (y con él, la ventana entera) mientras escanea carpetas con
  muchos archivos o subcarpetas; procesa las entradas de cada nivel en paralelo
  con `Promise.all`.
- `hashFileAsync`, `quickHashFile` — hash completo (stream) y hash rápido
  (cabecera+cola). `quickHashFile` usa `fs.promises` (E/S asíncrona) en vez de
  `fs.openSync`/`readSync`, para no bloquear el hilo del proceso principal
  mientras se calculan hashes de muchos archivos.
- `listDrives`, `detectDriveType` — detección de discos y su tipo (SSD/HDD/USB)
  vía PowerShell, con `execFile` asíncrono en vez de `execFileSync`. La letra
  de disco que se interpola en el comando de `detectDriveType` viene de
  `/^([A-Za-z])/`, que sólo puede capturar un único carácter alfabético — no
  hay forma de inyectar nada ahí.
- `pickConcurrency` — heurística de concurrencia según tipo de disco y tamaño
  promedio de archivo.
- `hideFolder` — aplica atributos oculto+sistema a una carpeta.

`main.js` sólo importa este módulo y conecta cada función a su canal IPC; no
duplica la lógica. Es el único de los cuatro archivos de lógica (`main.js`,
`preload.js`, `lib/core.js`, `renderer/app.js`) con tests automatizados
(`test/core.test.js`, 37 tests) — `main.js` y `app.js` sólo se verifican
corriendo la app a mano.

---

### `preload.js` — Puente seguro (contextBridge)

Corre en un contexto intermedio con acceso limitado. Expone `window.kopiaAPI` a la
interfaz usando `contextBridge.exposeInMainWorld`, que es el mecanismo oficial de
Electron para comunicación segura. Es literalmente la lista de funciones que la
ventana puede usar — cada línea es un método de `window.kopiaAPI` que reenvía
la llamada a `main.js` por IPC.

La interfaz sólo puede llamar a las funciones que este archivo expone explícitamente.
No tiene acceso a Node.js ni al sistema de archivos directamente.

---

### `renderer/index.html` — Estructura de la pantalla

Todo lo que corre dentro de la ventana no tiene acceso a Node.js ni al sistema
de archivos: todo pasa por `window.kopiaAPI`.

- **Barra de título** (`#titlebar`, ventana sin marco): logo + nombre, botón de
  tema claro/oscuro (`#themeToggle`) y los controles propios de
  minimizar/maximizar/cerrar (`#winMin`/`#winMax`/`#winClose`, ya que no hay
  barra nativa de Windows).
- **Riel de navegación** (`.nav-rail`, izquierda): las tres pestañas —
  **Backup**, **Comparar** y **Restaurar** (`#tabBackup`/`#tabCompare`/
  `#tabRestoreFull`, cada una con un `title` que explica qué hace) — y, debajo,
  el panel **Registro** (`.log-panel`): la lista de eventos (`#logList`) y el
  botón **Borrar** (`#clearHistoryBtn`) que la vacía.
- **Franja de contadores** (`.stat-strip`, arriba del área de trabajo):
  carpetas agregadas, cambios detectados, copiados y deduplicados
  (`#sourceCount`/`#changeCount`/`#copiedCount`/`#dedupedCount`).
- **Lienzo principal** (`.canvas`): el aviso de espacio insuficiente
  (`#spaceWarning`, oculto hasta que hace falta), el aviso de backup
  interrumpido (`#journalNotice`, con botones "Continuar y limpiar" / "Ahora
  no"), la barra de progreso, y la vista activa según la pestaña:
  - **Backup**: tarjeta de origen (accesos rápidos `#quickFolders` + carpetas
    agregadas), tarjeta de destino (disco + espacio), tarjeta de **Opciones**
    (versionado, verificación profunda, deduplicación, "Mostrar detalles
    técnicos", y un cuadro de texto `#excludeInput` para exclusiones
    adicionales — se suman a `DEFAULT_EXCLUDES`, no lo reemplazan), la barra
    de acción (`#scanBtn`/`#backupBtn`) y los resultados del escaneo.
  - **Comparar** / **Restaurar**: sus propias vistas (`#compareView` /
    `#restoreFullView`), ocultas con `hidden` hasta que se selecciona la
    pestaña.

Cada opción, pestaña y categoría de archivos tiene un tooltip (`title`) que
explica en lenguaje simple qué hace al pasar el mouse.

Hay un `<template>` (`folderTemplate`) que `app.js` clona por cada carpeta
escaneada, para no repetir HTML a mano.

---

### `renderer/app.js` — Lógica de la interfaz

Corre en el renderer de Electron, sin acceso a Node.js. Se comunica con el proceso
principal exclusivamente a través de `window.kopiaAPI`. Todo gira en torno a un
objeto `state` en memoria (no hay framework, es JS plano):

- **Tema claro/oscuro** (`initTheme`/`applyTheme`) — al iniciar, lee la
  preferencia guardada en `localStorage` (clave `kopiaDeskTheme`, o el tema del
  sistema operativo si nunca se eligió uno) y la aplica como atributo
  `data-theme` en `<html>`. El botón de la barra de título alterna entre ambos
  — es puramente visual, no pasa por `main.js`.
- **Carpetas rápidas** (`loadQuickFolders`/`addFolderToSources`) — al
  arrancar, pide a `main.js` la lista de carpetas típicas del usuario que
  existan en este equipo y dibuja un botón por cada una en `#quickFolders`. Un
  clic la agrega directo a `state.sources`, sin pasar por el diálogo nativo.
- **Escanear** (`scanAll`) — por cada carpeta de origen: pide el manifiesto
  anterior a `main.js`, escanea la carpeta actual (aplicando las exclusiones
  por defecto más las que el usuario haya escrito en `#excludeInput`), y llama
  a `compareManifests()` para clasificar cada archivo en nuevo/cambiado/
  eliminado — usando el hash rápido para decidir si un archivo con fecha
  distinta pero mismo tamaño realmente cambió de contenido. Cada carpeta corre
  en su propio try/catch: si una falla (p. ej. un origen desconectado), las
  demás igual se muestran en vez de perderse todas.
- **Elegir destino** (`selectDestination`) — al elegir un disco: se calcula el
  espacio libre y se le pregunta a `main.js` qué tipo de disco es para
  sugerir la concurrencia de copia (`driveInfo`, sólo visible con "Mostrar
  detalles técnicos"). Después se ejecuta `journalPeek()`: si el backup
  anterior quedó interrumpido, se muestra `#journalNotice`, y sólo si el
  usuario confirma se llama a `journalCheck()` para limpiarlo. Si elige "Ahora
  no", la limpieza queda pendiente (`state.journalPending`) y se hace
  automáticamente antes del próximo backup a ese disco.
- **Copiar** (`backupAll`) — el espacio se controla en vivo
  (`updateSpaceStatus`): si lo seleccionado no entra en el destino, el aviso
  amarillo explica cuánto falta y "Copiar aceptados" queda deshabilitado.
  Calcula la concurrencia recomendada una sola vez para toda la corrida, copia
  cada carpeta (con deduplicación y versionado si están activados), guarda el
  nuevo manifiesto, recuerda la ruta de origen (`rememberSourcePath`) y guarda
  un registro de la operación.
- **Comparar** (`loadComparePreview`/`compareSelected`) — lista las carpetas
  del backup, cada una con checkbox y su carpeta local conocida (o un botón
  para elegirla). No se compara nada automáticamente: hay que marcar,
  confirmar la ubicación local y apretar "Comparar seleccionados". Si el
  escaneo detecta archivos que figuran como respaldados pero ya no están en el
  disco de backup (`lostFromBackup`), ofrece quitarlos del manifiesto para que
  el próximo backup los recopie.
- **Restaurar** (`loadFullRestoreList`/`renderFullRestoreRow`) — lista las
  carpetas del backup sin comparar contra nada: cada fila tiene un botón
  "Restaurar a..." que copia **todo** el contenido de esa carpeta a la
  ubicación que elijas. Pensada para cuando la carpeta o el usuario de Windows
  originales ya no existen.
- **Persistencia** (`saveState`/`loadState`) — guarda en la configuración del
  usuario (no en el proyecto) qué carpetas había elegidas, qué disco, el
  estado de los interruptores y las exclusiones personalizadas. El tema
  claro/oscuro se guarda aparte, en `localStorage`.
- **Desambiguación de nombres** (`uniqueSourceName`) — si una carpeta origen
  nueva coincide en nombre con otra ya agregada, le agrega automáticamente la
  carpeta padre o un sufijo numérico, para que no compartan manifiesto ni
  carpeta de backup en destino (ver "Seguridad").

**Estado principal (`state`):**

| Campo | Tipo | Descripción |
|---|---|---|
| `sources` | `{name, path}[]` | Carpetas de origen (agregadas por diálogo o accesos rápidos) |
| `destination` | `object \| null` | Disco destino con `root`/`free`/`total`/`label` |
| `comparisons` | `object[]` | Resultado del último escaneo por carpeta (nuevos/cambiados/eliminados) |
| `copied` | `number` | Total de archivos copiados en la última corrida |
| `deduped` | `number` | Total de archivos enlazados por deduplicación en la última corrida |
| `busy` | `boolean` | Si hay una operación en curso (deshabilita botones) |
| `excludePatterns` | `string[]` | Patrones de exclusión por defecto (vienen de `main.js`) |
| `compareSources` | `object[]` | Carpetas del backup listadas en la pestaña "Comparar" |
| `compareSelection` | `object` | Qué carpetas están marcadas para comparar y su carpeta local asociada |
| `journalPending` | `boolean` | Si quedó una limpieza de journal pospuesta ("Ahora no") pendiente antes del próximo backup |

---

### `renderer/styles.css` — Estilos

Hoja de estilos CSS vanilla, sistema visual "Fluent Obsidian" (Windows 11 Fluent 2
+ Mica, acento cobalto del sistema). Sin dependencias externas: tipografía del
sistema (Segoe UI Variable / Segoe UI) y monoespaciada (Cascadia Code /
Consolas), coherente con la CSP de la app (`script-src`/`style-src 'self'`).
Define una paleta de variables de color, componentes reutilizables (botones,
tarjetas, badges, barra de progreso con animación shimmer), layout de dos
columnas con riel de navegación, y breakpoints para pantallas pequeñas.

**Variables de color principales** (definidas en `:root` para el tema claro; se
sobreescriben en `:root[data-theme="dark"]` y también automáticamente vía
`@media (prefers-color-scheme: dark)` cuando el usuario nunca eligió un tema
manualmente):

| Variable | Claro | Uso |
|---|---|---|
| `--primary` / `--primary-deep` | `#0078d4` / `#005ea3` | Acciones primarias, contador de carpetas, acentos activos |
| `--secondary` | `#0a76c4` | Contador de cambios detectados, detalles técnicos |
| `--good` | `#16a34a` | Éxito, archivos copiados, botón de backup habilitado |
| `--warn` | `#b45309` | Avisos, cambios pendientes |
| `--bad` | `#dc2626` | Errores, archivos eliminados/perdidos |
| `--ink` / `--ink-variant` | `#1b1f27` / `#4c525c` | Texto principal / secundario |
| `--outline` / `--outline-variant` | `#74777f` / `#ccd0d8` | Bordes sutiles, iconos apagados |
| `--surface`, `--surface-low/high/highest` | grises reales (sin blanco puro) | Fondos de tarjetas, riel lateral, franja de contadores |
| `--overlay` | gris translúcido | Fondo de titlebar y paneles superpuestos |

**Tema claro/oscuro**: `app.js` alterna el atributo `data-theme` en `<html>`
(`initTheme()` / botón `#themeToggle`) y guarda la preferencia en
`localStorage` bajo la clave `kopiaDeskTheme` (no pasa por `main.js`, es
puramente visual). Todo el resto de la hoja de estilos usa estas variables en
vez de colores fijos, así que el cambio de tema no requiere tocar ninguna otra
regla.

---

### `package.json` / `package-lock.json`

Define el nombre del paquete, las dos dependencias (`electron` y
`electron-builder`, ambas sólo de desarrollo) y los scripts:

| Script | Qué hace |
|---|---|
| `npm start` | Lanza la app en modo desarrollo |
| `npm test` | Corre `test/core.test.js` con `node --test` (no requiere Electron) |
| `npm run build` | Empaqueta como instalador NSIS para Windows en `dist/` |

La configuración de `electron-builder` especifica el icono, el `appId`
(`com.kopiadesk.app`), y el target `nsis` que genera un instalador estándar de
Windows. `package-lock.json` fija las versiones exactas de todo lo instalado;
lo mantiene npm automáticamente, no se edita a mano.

---

### `assets/`

Contiene `Kopia_Desk_icon.png`, el icono de la aplicación. Se usa en tres
lugares: `main.js` lo carga como icono de la ventana (`BrowserWindow`),
`package.json` lo referencia como icono del instalador y del ejecutable final
(`dist/Kopia Desk Setup *.exe`), y `renderer/index.html` lo muestra como logo
en la barra de título. Si se reemplaza por otro PNG (idealmente cuadrado,
256×256 o más), el icono cambia en toda la app sin tocar código.

### `dist/`

No se edita a mano: la genera `electron-builder` al ejecutar `npm run build`.
Contiene el instalador final (`Kopia Desk Setup *.exe`), su `.blockmap`, y
`win-unpacked/` (la app compilada sin empaquetar). Se puede borrar y
regenerar en cualquier momento — no guarda nada que no se pueda volver a
generar. Si falla por un error de `winCodeSign`, ver "Notas de desarrollo".

### `node_modules/`

Dependencias instaladas por `npm install`, a partir de `package.json` y
`package-lock.json`. No se edita nada a mano aquí — si algo se ve raro,
borrar la carpeta y reinstalar (`Remove-Item -Recurse -Force node_modules;
npm install`).

### `docs/design-reference/`

Contiene un mockup estático (`code.html` + `screen.png` + `DESIGN.md`, dentro
de un `.zip`) con la propuesta de rediseño visual "Kopia Fluent Obsidian" que
dio origen al sistema de colores actual de `styles.css`. No se puede usar tal
cual dentro de la app — carga Tailwind y Google Fonts por CDN, bloqueados por
la CSP (`script-src`/`style-src 'self'`) — así que su lenguaje visual ya está
reimplementado de forma nativa en `renderer/styles.css`. Queda sólo como
referencia de diseño (paleta exacta, tokens de espaciado) por si se quiere
afinar algún detalle más adelante.

---

## Flujo de backup paso a paso

```
Usuario elige carpetas origen + disco destino
         ↓
[app.js] Escanea cada carpeta origen (IPC → main.js)
         ↓
[main.js] scanDirectoryRecursive → devuelve mapa { relativePath → {size, mtime, hash} }
         ↓
[app.js] Carga manifiesto anterior de cada carpeta (IPC → main.js)
         ↓
[app.js] Compara escaneo vs manifiesto:
         - Archivo en escaneo pero no en manifiesto → NUEVO
         - Archivo en ambos con mtime/size diferente → CAMBIADO
         - Archivo en manifiesto pero no en escaneo → ELIMINADO
         ↓
[app.js] Muestra resultados, usuario acepta/omite categorías por carpeta
         ↓
[app.js] Construye lista de tareas de copia y las envía en lote (IPC → main.js)
         ↓
[main.js] Copia archivos con concurrencia adaptativa, emite progreso por cada archivo
         ↓
[app.js] Actualiza manifiesto con el nuevo estado (IPC → main.js)
         ↓
[main.js] Guarda manifiesto JSON + oculta carpeta de metadatos
         ↓
[app.js] Guarda registro JSON de la operación
```

---

## Estructura del backup en disco destino

```
D:\KopiaDesk_Backup\
├── Fotos\              ← archivos copiados (estructura original preservada)
├── Documentos\         ← archivos copiados
└── .kopia-data\        ← oculta (atributo +h +s)
    ├── manifests\
    │   ├── Fotos.json         ← estado actual
    │   ├── Fotos.prev.json    ← estado anterior (1 versión atrás)
    │   └── Documentos.json
    ├── versions\       ← versiones anteriores de archivos cambiados
    └── logs\           ← registros JSON por operación
```

---

## Seguridad

- **Aislamiento de contexto**: `contextIsolation: true`, `nodeIntegration: false`.
  La interfaz no tiene acceso a Node.js; todo pasa por `preload.js`.
- **Path traversal**: `safePath()`/`safeBackupPath()` resuelven y validan que
  la ruta quede dentro del disco/carpeta de backup antes de cualquier
  operación de escritura — **y también antes de leer** un archivo cuya ruta
  llegó desde el renderer (`restore:copy-files` revalida `backupFullPath` con
  `safeBackupPath` en vez de confiar en lo que manda la interfaz).
- **Tamaño de manifiesto**: se rechaza si supera 50 MB (protección contra corrupción).
- **Validación de entradas**: las rutas se verifican antes de pasar a `execFile`.
- **Sin cifrado propio**: se probó un cifrado AES-256-GCM por archivo y se quitó
  porque no aportaba suficiente frente a cifrar el disco USB completo (BitLocker
  u otra herramienta a nivel de disco) — queda como posible mejora futura si se
  aborda ese enfoque en vez de cifrar archivo por archivo.
- **Deduplicación**: usa hardlinks de NTFS (`fs.link`) sobre un índice de
  contenido (`.kopia-data/content-index.json`, hash → ruta). Si el sistema de
  archivos no soporta el enlace, se recurre automáticamente a una copia normal.
- **Journal de operaciones**: antes de copiar, se escribe
  `.kopia-data/journal/<fecha>.json` con el estado de cada archivo (pendiente/
  hecho). Si la app se cierra abruptamente o el disco se desconecta a mitad de
  copia, la próxima vez que se seleccione ese destino la UI lo detecta con
  `journal:peek`, muestra un aviso explicando qué pasó y, sólo si el usuario
  confirma ("Continuar y limpiar"), `journal:check` elimina los archivos que
  quedaron a medio escribir, evitando que un backup parcial se confunda con
  uno completo. Si elige "Ahora no", se vuelve a avisar la próxima vez.
- **Sin colisión de nombres entre carpetas origen**: el manifiesto y la
  carpeta de backup de cada origen se nombran con `safeName(source.name)`. Si
  dos carpetas distintas (p. ej. `C:\ProyectoA\Backup` y `D:\ProyectoB\Backup`)
  sanearían al mismo nombre, `uniqueSourceName()` en `app.js` le agrega a la
  segunda la carpeta padre o un sufijo numérico antes de agregarla, para que
  no terminen mezclando su historial de nuevos/cambiados/eliminados en el
  mismo manifiesto.

---

## Notas de desarrollo

- `npm test` corre la suite de `test/core.test.js` con el test runner nativo
  de Node (`node --test`) contra `lib/core.js`; no requiere Electron.
  `main.js` y `renderer/app.js` no tienen tests automatizados — se verifican
  corriendo la app a mano.
- Para construir el instalador en Windows, electron-builder necesita el paquete
  `winCodeSign` en su caché. Si falla con error de symlinks, copiar el directorio
  extraído manualmente a:
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
- Ejecutar `npm start` desde **cmd como administrador** si hay problemas de permisos
  con la detección de discos o el atributo de carpetas ocultas.
- Variable de entorno para build sin firma de código:
  `set CSC_IDENTITY_AUTO_DISCOVERY=false && npm run build`
