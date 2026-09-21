# pi-prompt-enhancer

pi に送るプロンプトを毎回 TypeSafe の意思決定モデル [jev](https://docs.typesafe.ai) で採点し、足りていない項目を **footer の常設 status** に出す pi 拡張。

プロンプトは送信された瞬間に、入力タイプ（質問 / タスク依頼 / 分析 / 創作 / 雑談）に分類され、そのタイプに必要な項目を満たしているかが確かめられる。結果は footer に出るので、プロンプト本文は汚れない。同じ内容をモデルにも非表示で渡すため、モデルは推測せずに質問できる。

## 仕組み

```
                  ┌─ 送信前: 350ms ごとに editor を読む
ユーザーが入力中 ──┤   └─ 700ms 静止したら 15 個の質問を jev へ（1 リクエスト）
                  │        └─ ctx.ui.setStatus() で footer に反映 ← ここで見える
                  │
                  └─ Enter: 直近の評価を再利用してモデルへ渡す
                       └─ before_agent_start で display: false のメッセージ
                          （プロンプト本文は書き換えない）
```

判定の中身は `src/assess.ts` が持つ。

- `input_type` … どのチェックリストを使うか（confidence が低ければ汎用項目へ）
- `clarity` / `specificity` … 総合スコアに重み付け
- `has_*` … 項目ごとの有無（Noul）。0.5 未満を「不足」とする

送信前評価は、**pi に editor 変更イベントが無い**（全イベントを確認済み）ため `ctx.ui.getEditorText()` を 350ms ごとに読むポーリングで実現している。文字列を読むのは無料、jev は無料ではない。そこで `src/watch.ts` が「700ms 静止したときだけ」「同じ本文には二度叩かない」を判断する。送信時は直近の評価をそのまま使うので、二重にリクエストしない。

mid-stream の割り込み（`steer`）とエージェント実行中は評価しない。jev の 250〜650ms が修正の即時性を損なうため。

jev は散文を返さず確率しか返さないため、ヒント本文は `src/checklist.ts` の静的な表から選ぶ。どの判断をモデルに任せ、どの判断をコードが持つかを分けている（TypeSafe の [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) と同じ考え方）。

### 出力例

footer に常設で出る。

```
π タスク依頼 0/100 D · 不足5: 目的・ゴール, 背景・前提, 制約, 出力形式, 完了条件
```

問題がないプロンプトなら `π タスク依頼 92/100 A · 不足なし`。API キーが無ければ `π TYPESAFE_API_KEY 未設定`、呼び出しに失敗すれば `π jev 失敗: <理由>` と、失敗も footer に残る（黙って死なない）。

モデルには別途 `<prompt_assessment>` ブロックが `display: false` で渡る。文字起こしには出ず、モデルの文脈にだけ入る。

## インストール

```sh
pi install npm:@hikae/pi-prompt-enhancer
```

一時的に試す場合:

```sh
pi -e npm:@hikae/pi-prompt-enhancer
```

## 設定

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | （なし） | 必須。[dashboard](https://console.typesafe.ai/keys) で発行する |
| `TYPESAFE_MODEL` | `jev-latest` | 使う jev のモデル / エイリアス |

キーが無い場合や呼び出しに失敗した場合は、警告を 1 回出すだけでプロンプトはそのまま通る。プロンプトを止めることはない。

## 判定基準

チェック項目は Claude の [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) をそのまま項目にしたもの。タイプごとに必要な項目が違う。

| タイプ | 必須項目 |
| --- | --- |
| 質問 | 目的・ゴール / 背景・前提 / 試したこと / 用途 |
| タスク依頼 | 目的・ゴール / 背景・前提 / 制約 / 出力形式 / 完了条件 |
| 分析 | 目的・ゴール / 背景・前提 / 対象データ / 評価軸 / 出力形式 |
| 創作 | 目的・ゴール / 背景・前提 / 読み手 / トーン・文体 / 例 |
| 雑談 | （なし） |

スコアは `0.4 × 項目の充足率 + 0.3 × 明確さ + 0.3 × 具体性` で 0〜100、A/B/C/D に丸める。重みと閾値はすべて `src/assess.ts` にある。

## 既知の制約

- **書きかけは必ず「不足」になる。** チェックリストは「書かれているか」を見るので、入力途中は全項目が不足に見える。価値は、項目を足すにつれてスコアと表示が変わっていくことを確認できる点にある。確定した評価が欲しいのは Enter を押した時点。
- **送信前に何度もリクエストが飛ぶ。** タイプ中に止まるたびに 1 リクエスト発生する（250〜650ms / 1回）。頻度を下げたいなら `POLL_MS` / `QUIET_MS` を、送信前評価自体を止めるなら `session_start` の `setInterval` を外す。
- **短い入力も評価する。** 文字数では足切りしない。日本語は数文字で依頼が成立するので（「いい感じにして」は7文字）、文字数を基準にすると本物の依頼を静かに落とす。雑談は `chitchat` 分類が弾くため status は `不足なし` になる。
- **直近の 1 メッセージしか見ていない。** 会話の文脈は判定に渡していないため、前のターンで共有済みの項目を「不足」と言うことがある。モデルに渡すブロックにその旨を書いてあるので、モデル側は無視できる。会話も state に渡せば解消できる。
- **status は 1 行。** ラベルまでしか入らず、ヒント本文（何を足せばよいか）は footer には出ない。本文まで見たい場合は `ctx.ui.setStatus` を `ctx.ui.setWidget` に替える。
- **モデルへの注入は `before_agent_start`。** 送信前評価は editor を見るだけ、モデルへの受け渡しだけはターン確定後に発火するこのフックを使う。`input` の `transform` はプロンプト本文を書き換えてしまうため採らない。
- **instructions は英語、ヒントは日本語。** jev の主言語が英語のため質問は英語で書いている。日本語のヒントはユーザーが読むため。
- **jev は CJK の精度が英語より低い**（[Models](https://docs.typesafe.ai/models#language-support)）。日本語プロンプトの判定は英語プロンプトより不確かになりうる。
- **リトライしない。** 429 / 529 でも即座に諦めて素通しする。次のプロンプトがまた試すので、エージェントを待たせるより安い。

## 開発

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm check` で両方まとめて実行する。実 API を叩く確認は `TYPESAFE_API_KEY` を設定したうえで:

```sh
TYPESAFE_API_KEY=... node --input-type=module -e '
import { askJev } from "./src/jev.ts";
import { buildQuestions } from "./src/checklist.ts";
import { assess, renderAssessment } from "./src/assess.ts";
const answers = await askJev({ request: "いい感じに直して" }, buildQuestions());
console.log(renderAssessment(assess(answers)));
'
```

## ライセンス

MIT
