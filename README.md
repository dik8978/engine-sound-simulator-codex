# Engine Sound Simulator

物理ベースの手続き合成によるエンジンサウンドシミュレータ。
排気量・気筒数・エンジン形式などのパラメータから音をリアルタイム生成し、
OSC で外部からスロットル/ブレーキ等を制御できます。
ブラウザだけで動く音源部分は Cloudflare Pages などの静的ホスティングにも公開できます。

## 起動

```bash
npm install
npm start
```

- Web UI: http://localhost:3000
- OSC 受信: UDP ポート 9000

ポート変更: `PORT=8080 OSC_PORT=9001 npm start`

ブラウザで「オーディオを開始」ボタンを押すと音が出ます(ブラウザの自動再生制限のため初回クリックが必要)。

## 仕組み

- **音合成** (AudioWorklet 内、サンプル単位):
  クランク角の進行 → エンジン形式ごとの点火角で気筒ごとの爆発パルスを生成
  → バンク別の排気管共鳴(1/4波長コムフィルタ)→ 歪み → マフラーLPF → 吸気ノイズ加算
- **車両物理**: トルクカーブ、ギア比(最高速度から自動算出)、空気抵抗(最高速度で頭打ちになるよう自動算出)、
  クラッチスリップ発進、レブリミッター(燃料カット)、AT自動変速、減速時アフターファイア

## 操作 (テスト用)

- `W` / `↑` : アクセル、`S` / `↓` : ブレーキ (縦ペダルスライダーでも操作可)
- `E` : シフトアップ、`Q` : シフトダウン、`N` : ニュートラル
  (ATモード中に手動シフトすると2.5秒間は自動変速を保留)
- 設定パネルの変更は**リアルタイムに音へ反映**(適用ボタン不要)
- 最終EQ: Low / Low-Mid / Presence / High の4バンドを後段Web Audioフィルタで微調整
- プリセット: 内蔵プリセットに加え、現在の設定を名前を付けて保存可能(localStorage)
- メーター: タコメーター + スピードメーター(スケールは設定から自動)
- RPMモード: 内部シミュレーション / 外部RPM直接指定 を切替可能
- デバッグ: ブラウザコンソールで `sendCommand('testpop')` → アフターファイア単発

## OSC アドレス一覧

TouchDesigner / TouchOSC などから UDP ポート 9000 (デフォルト) に送信してください。

| アドレス | 引数 | 説明 |
|---|---|---|
| `/engine/throttle` | float 0–1 | スロットル開度 |
| `/engine/brake` | float 0–1 | ブレーキ入力 |
| `/engine/accel`, `/engine/accelerator`, `/engine/gas` | float 0–1 / 0–100 / 0–127 | スロットル開度の別名 |
| `/accel`, `/accelerator`, `/gas`, `/throttle` | float 0–1 / 0–100 / 0–127 | スロットル開度の短縮アドレス |
| `/brake` | float 0–1 / 0–100 / 0–127 | ブレーキ入力の短縮アドレス |
| `/engine/pedals`, `/pedals` | throttle brake | 2引数でアクセル/ブレーキを同時指定 |
| `/engine/rpm` | float | 外部RPMモード時の回転数指定 |
| `/engine/load` | float 0–1 | 外部RPMモード時の負荷(省略時はthrottleを使用) |
| `/engine/gear` | int (0=N) | ギア直接指定 |
| `/engine/gearup` / `/engine/geardown` | (なし) | シフト操作 |
| `/engine/ignition` | 0/1 | イグニッション |
| `/engine/mode` | 0=sim / 1=ext (または "sim"/"ext") | RPMモード切替 |
| `/engine/config/<key>` | float/string | エンジン設定の変更 (例: `/engine/config/displacement 5.7`) |

`<key>` に使える名前: `displacement, cylinders, layout, firingUnevenness, idleRpm, redline,
maxTorque, peakTorqueRpm, maxSpeedKmh, vehicleMass, numGears, transmission, engineInertia,
engineBrake, pipeLength, muffler, drive, intakeNoise, crackle, turboWhine, mechanicalNoise,
camLope, eqLow, eqLowMid, eqPresence, eqHigh`

### TouchDesigner からの送信例

OSC Out DAT / CHOP で `localhost:9000` に向けて上記アドレスを送るだけです。
スロットル/ブレーキ/RPM は UI・キーボード・OSC の最大値が採用されるため、混在して操作できます。

## 公開

### Cloudflare Pages

Cloudflare Pages の Direct Upload は、ビルド済みの静的アセットをアップロードして
`<PROJECT_NAME>.pages.dev` のURLで公開できます。Wranglerを使う場合:

```bash
npm run deploy:cloudflare
```

Cloudflare APIトークンを使わずにダッシュボードから公開する場合:

```bash
npm run build:static
```

で `dist/engine-sound-simulator-public.zip` を作り、Cloudflare Dashboard の
Workers & Pages → Create application → Pages → Drag and drop にアップロードしてください。

初回は Cloudflare のログインとプロジェクト作成が必要です。Cloudflareダッシュボードから
Drag and drop で公開する場合は、`public/` フォルダをアップロードしてください。

注意: 公開された静的サイトでは、Web Audioによるエンジン音とUI操作は動きますが、
OSC UDP受信はブラウザ/静的ホスティングだけでは動きません。OSCを使う場合はローカルで
`npm start` を起動し、TouchDesigner / TouchOSC などから `localhost:9000` に送ってください。

## 音響モデルのメモ

- クランク角同期の排気パルス列を中心にし、排気系を短い共鳴器として通す Pulse-Train / Resonator 型。
- RPM/負荷に追従する engine order 成分を足して、車種ごとの倍音バランスを調整しやすくしています。
- 吸気マニホールド、ターボスプール、減速燃料カット、燃焼タイミングの微小揺れを入れ、完全な周期信号に寄りすぎないようにしています。
- 最終EQは合成ロジックの後段に置いているため、録音や好みに合わせた最後の追い込み用です。

## 動作確認用のOSC送信 (Node ワンライナー)

```bash
node -e "
const d=require('dgram').createSocket('udp4');
function pad(s){const n=Math.ceil((s.length+1)/4)*4;const b=Buffer.alloc(n);b.write(s);return b}
const msg=Buffer.concat([pad('/engine/throttle'),pad(','+'f'),(()=>{const b=Buffer.alloc(4);b.writeFloatBE(0.8);return b})()]);
d.send(msg,9000,'127.0.0.1',()=>d.close());
"
```
