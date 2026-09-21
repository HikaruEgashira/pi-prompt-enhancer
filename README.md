# pi-prompt-enhancer

pi に送るプロンプトを毎回 TypeSafe の意思決定モデル [jev](https://docs.typesafe.ai) で採点し、足りていない項目をヒントとして差し込む pi 拡張。

プロンプトは送信された瞬間に、入力タイプ（質問 / タスク依頼 / 分析 / 創作 / 雑談）に分類され、そのタイプに必要な項目を満たしているかが確かめられる。足りない項目はそのまま会話に差し込まれるので、ユーザーは何を足せばよいか分かり、モデルは推測せずに質問できる。

## 仕組み

```
ユーザーがプロンプトを送信
  │
  ├─ before_agent_start で状態 { request: <プロンプト> } と 15 個の質問を
  │  POST https://api.typesafe.ai/v1/systemone へ投げる（1 リクエスト）
  │
  └─ 返ってきた確率を src/assess.ts で判定する
       ├─ input_type   … どのチェックリストを使うか（confidence が低ければ汎用項目へ）
       ├─ clarity / specificity … 総合スコアに重み付け
       └─ has_*        … 項目ごとの有無（Noul）。0.5 未満を「不足」とする
            │
            └─ 不足があれば custom message を注入（ユーザーに表示 + モデルに送信）
```

jev は散文を返さず確率しか返さないため、ヒント本文は `src/checklist.ts` の静的な表から選ぶ。どの判断をモデルに任せ、どの判断をコードが持つかを分けている（TypeSafe の [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) と同じ考え方）。

### 出力例

```
プロンプト評価: タスク依頼 / confidence 1.00 — 14/100 (D)

不足している項目 (4):
- 背景・前提: 背景・前提・なぜそれを聞きたいのかを添える。
- 制約: 守るべき条件を書く（言語・依存・対象範囲・締切・禁止事項）。
- 出力形式: 欲しい形式・長さ・構成を指定する（箇条書き / 表 / コード / 〜字以内）。
- 完了条件: 何をもって完了とするか、確認方法を書く（テスト・受け入れ条件）。

※ 直近の1メッセージだけを評価しています。会話ですでに共有済みの項目は不足に数えないでください。
```

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

- **直近の 1 メッセージしか見ていない。** 会話の文脈は判定に渡していないため、前のターンで共有済みの項目を「不足」と言うことがある。注入メッセージにその旨を書いてあるので、モデル側は無視できる。会話も state に渡せば解消できる。
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
