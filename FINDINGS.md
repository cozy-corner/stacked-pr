# GitHub Stacked PR 検証メモ

2026-08-21 に `cozy-corner/stacked-pr` で実施した検証の記録。
各項目は実際にコマンドを実行して確認した結果であり、末尾に未検証の事項を分けて記載する。

環境: `gh` 2.97.0 / `gh-stack` v0.1.0

## 0. 前提

GitHub ネイティブの Stacked PR は 2026-07-30 に public preview で提供開始。
それ以前から「PR の base に親ブランチを指定して連鎖させる」運用は可能だったが、
GitHub 側にスタックという概念はなかった。

- [Stacked pull requests are now in public preview](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)

## 1. 素の git + gh で作るスタック

`gh pr create --base <親ブランチ>` を連鎖させるだけで、各 PR の差分は自分の層だけに保たれる。
拡張も特別な機能も不要。

```
main ← step-1 (#1) ← step-2 (#2) ← step-3 (#3)
```

同一ファイルを3層とも変更しても、各 PR の Files changed は自分の層の差分のみ。
ただし GitHub 側にスタックオブジェクトは作られないため、スタック UI・
cascading rebase・一括マージは使えない。

## 2. GitHub ネイティブのスタック

### 保存場所が2つある

| | ローカル | GitHub |
|---|---|---|
| 実体 | `.git/gh-stack`（JSON） | `PRS_` オブジェクト、`/repos/{owner}/{repo}/stacks/{number}` |
| 作られる契機 | `gh stack init` / `gh stack add` | `gh stack submit` |
| 消し方 | `gh stack unstack --local` | `gh stack unstack <番号>` |
| 用途 | rebase の判断、ナビゲーション | PR 画面のスタック表示、一括マージ |

ローカル側の実体:

```json
{
  "schemaVersion": 1,
  "stacks": [{
    "trunk":    { "branch": "main",    "head": "03d7732..." },
    "branches": [
      { "branch": "stack-1", "base": "03d7732..." },
      { "branch": "stack-2", "base": "75b2de6..." },
      { "branch": "stack-3", "base": "d268d29..." }
    ]
  }]
}
```

- git の ref でも config でもない、拡張が独自に置くファイル。git 本体はこの階層を知らない
- 記録するのは「積んだ時点の親のコミットハッシュ」。ブランチ名ではない
- このハッシュと現在の親先頭のズレが `gh stack view` の `⚠` の正体
- `.git/` 配下なので clone されない。別マシンには引き継がれない
- `branches` は順序付き配列。**木構造も循環も表現できない**

GitHub 側は PR リソースの一次データとして持つ（PR body にコメント表を書き込む方式ではない）:

```json
"stack": { "id": 528804, "number": 4, "base": {"ref": "main"}, "size": 3, "position": 2 }
```

`node_id` の接頭辞は PR が `PR_`、スタックが `PRS_` で型として別物。

### スタック番号は PR/issue と共通カウンタ

PR #1〜#3 のリポジトリでスタックを作ると `#4` になり、次の PR は `#5` から始まった。
削除したスタックの番号は欠番のまま返ってこない（`pulls/4`・`issues/4`・`stacks/4` すべて 404）。

### submit と push の違い

`gh stack submit` は4段階（`--help` より）:

1. 全ブランチを push
2. PR がないブランチに PR を作成
3. 既存 PR の base を更新
4. GitHub 側にスタックを作成/更新

`gh stack push` は 1 のみ。構造が変わらずコミットだけ更新したときは push で足りる。

## 3. rebase 方式であること

スタックが生きている間の同期手段は **rebase のみ**。merge で追従するコマンドは存在しない。
一方 main へ落とす際の方式は `--merge` / `--squash` / `--rebase` から選べる。

### force push は副作用ではなく前提

`stack-1` に1コミット追加して `gh stack rebase --upstack` + `gh stack push` した際の
PR タイムライン実測:

| PR | ブランチ | force push |
|---|---|---|
| #5 | stack-1（修正した層） | **0回**（追記なので早送り） |
| #6 | stack-2 | 1回（`head_ref_force_pushed`） |
| #7 | stack-3 | 2回（`head_ref_force_pushed` + `base_ref_force_pushed`） |

コミットハッシュは親を含めて計算されるため、下の層が動けば上の全層が別コミットになる。
上の層ほど「自分の書き換え + 下の全層の書き換え」の通知を浴びる。

force push が起きないケース: 一番下の層への**追記**のみ。
全層が force push になるケース: 下の層の `--amend` / squash、trunk への追従。

避けたければ rebase をやめて merge すればよいが、各層の差分に親の変更が混ざり、
スタックの利点そのものが失われる。

### push は非アトミック

`gh stack push --help` より:

> Updates are not atomic: a branch may update even if another branch is rejected.

ローカルの rebase が全層成功しても、push が途中で拒否されるとリモートが
中途半端な状態になる。

### コンフリクト時

cascading rebase は層ごとに停止する。下の層は適用済み、上の層は未着手のまま。

```
✓ Rebased stack-1 onto main
⚠ Rebasing stack-2 onto stack-1 — conflict
```

`gh stack rebase --continue` / `--abort` で継続・中断。`--abort` は全層を巻き戻す。
**`git rebase --quit` は使ってはいけない** — rebase 状態のフラグを消すだけで、
既にリベース済みの層と未着手の層が混在した不整合が残る。

## 4. 枝分かれはできない

| 検証 | 結果 |
|---|---|
| スタック途中で `gh stack add` | ✗ `can only add branches to the top of the stack` |
| `gh stack modify` | 分岐操作なし（drop / fold / insert / reorder / rename のみ） |
| `gh stack init --base <途中のブランチ> <新枝>` | ✓ 通る。ただし木ではなく**独立した第2スタック**として記録 |
| 分岐点のブランチで `view` / `rebase` / `push` | ✗ 全て `belongs to multiple stacks` |
| 親の変更が枝に伝搬するか | ✗ しない。枝は cascading rebase の対象外 |

分岐は作れてしまうが、作った瞬間に分岐点のブランチが操作不能になる。
「対話端末で選べ」というエラーなので手動なら回避できるが、スクリプトや CI では詰む。
そして自動追従の恩恵もない。**gh stack は直線専用**と考えるべき。

## 5. 階層構成（develop 連鎖 + 各段に feature スタック）

以下の構成は成立する。

```
main
 └─ develop-dbmigration  #9        （素の git）
     ├─ [stack #14] feat-db-1 #12 → feat-db-2 #13
     └─ develop-backend  #10       （素の git）
         ├─ [stack #17] feat-be-1 #15 → feat-be-2 #16
         └─ develop-frontend  #11  （素の git）
             └─ [stack #20] feat-fe-1 #18 → feat-fe-2 #19
```

### 守るべき制約

**develop 連鎖自体を `gh stack` に登録しないこと。** 登録すると各 develop が
「スタックのメンバー」かつ「feature スタックの trunk」になり、`belongs to multiple stacks`
で操作不能になる。

素の git のブランチ連鎖として持てば、各 develop は「1つのスタックの trunk」であって
どのスタックのメンバーでもないため、曖昧さが発生しない（3ブランチとも `gh stack view` 正常動作を確認）。

### `main` 以外を trunk にできる

`gh stack init --base develop-dbmigration feat-db-1` は GitHub 側の submit まで通る。
ドキュメントにも `--base develop` の例がある。

### 伝搬の使い分け

- **develop 間 = 通常のマージ** — `gh stack` の管理外。マージなら早送りで force push ゼロ。
  リベースすると develop とその上の feature スタック全部を巻き込む
- **develop 内 = `gh stack rebase`** — trunk が動いたので積み直しが必要。force push 発生

db の feature をマージしてから全層に届くまでに実際に打ったコマンド:

```bash
gh stack merge 14 --yes --squash                                    # feature を develop へ
git switch develop-backend  && git merge origin/develop-dbmigration && git push
git switch develop-frontend && git merge origin/develop-backend     && git push
git switch feat-be-2 && gh stack rebase && gh stack push
git switch feat-fe-2 && gh stack rebase && gh stack push
```

`gh stack rebase` は自分の trunk しか見ないので、**階層をまたぐ伝搬は完全に手動**。
feature がマージされて develop が進むたびに発生する。develop 連鎖が頻繁に動く構成では辛い。

### atomic stack merge は「1つに潰す」ではない

`gh stack merge 14 --yes --squash` の結果:

```
d3b9385 feat(db): add orders table (#13)
add0a57 feat(db): add users table (#12)
```

PR ごとに1コミット。atomic は all-or-nothing の意味であって、
「スタック全体を1コミットに squash する」ではない。層ごとの意味が履歴に残る。

## 6. base の自動書き換え（auto-retarget）

**stacked PR とは無関係の、2020年からある既存挙動。**
[Pull Request Retargeting (2020-05-19)](https://github.blog/changelog/2020-05-19-pull-request-retargeting/)

発火条件は3つすべてが必要:

1. その PR がマージ済み
2. その head ブランチが削除された
3. そのブランチを base にする **open** な PR が存在する

base を書き換える経路は2つあり、混同しやすい。

| | GitHub の auto-retarget | `gh stack submit` |
|---|---|---|
| 発火 | マージ済み head ブランチの削除時 | submit 実行時（明示的） |
| 主体 | GitHub が自動判断 | gh が API で base を指定 |
| 登場 | 2020-05-19 | 2026-07-30 |
| 繰り上がり | 1段だけ | スタック全体を把握 |
| コミットの追従 | **しない**（base フィールドのみ） | rebase で積み直す |

auto-retarget は base の付け替えだけでブランチの中身に触らない。
差分の見え方が変わるだけで、コミットは古い親の上に乗ったまま。

### `delete_branch_on_merge` はデフォルト無効

`gh repo create` にオプションを付けず作成したリポジトリで `delete_branch_on_merge: false`。
auto-retarget の発火条件がブランチ削除である以上、スタック運用では有効化が望ましい。

```bash
gh api -X PATCH repos/<owner>/<repo> -f delete_branch_on_merge=true
```

なお `gh stack` を使う場合は submit が base を明示的に付け替えるため、
GitHub の auto-retarget に依存しなくてよい。

## 7. 循環参照

### PR レベルの循環は作れる

2本（`a→b`, `b→a`）でも3本（`b→a`, `c→b`, `a→c`）でも、GitHub はエラーを出さず
全て `mergeable=MERGEABLE` / `CLEAN` になる。

GitHub は PR ごとに merge-base からの差分を独立して計算するだけで、
**base 参照グラフ全体の循環検出はしていない**。

### スタック上では循環できない

理由は2つ。どちらも「循環を検出したから」ではない。

1. `.git/gh-stack` の `branches` が順序付き配列 — 構造的に輪を書けない
2. 1ブランチは1スタックのメンバーにしかなれない — 輪を閉じようとすると
   `✗ branch "cyc-a" already exists in a stack`

### `gh stack init` は git の祖先関係を検証しない

互いに無関係な3本（全て `main` 直下）を `gh stack init cyc-a cyc-b cyc-c` で
登録すると、`main ← cyc-a ← cyc-b ← cyc-c` として**そのまま採用される**。
JSON に記録される `base` は実態どおり（3本とも main）だが、配列の順序が連鎖を意味する。

この状態で `gh stack rebase --upstack` を打つと、**存在しなかった連鎖が実体化する**。
順序を間違えて init すると、意図しない積み直しが黙って走る。

### 循環 PR は無警告で「マージ済み」になる

上記の rebase で `cyc-a` が `cyc-c` の祖先になった結果、輪を閉じていた
PR #25（`cyc-a → cyc-c`）は差分ゼロ・コミット0本になり、その後 `MERGED` に変わった。

```
state: MERGED
mergedBy: cozy-corner     ← 誰もマージ操作をしていない
mergeCommit: 48a2ecb      ← cyc-a 自身のコミット
timeline: closed / merged / base_ref_force_pushed
```

head のコミットが全て base に含まれた時点で、GitHub が自動的にマージ済みと判定する。
タイムラインに `merged` と自分の名前が残るため、後から見ると自分でマージしたように見える。

### 別名ブランチによる擬似循環も直線化する

`cyc-a` の内容を引き継いだ `cyc-a-dash` を作り、`cyc-c` を trunk として登録すれば
「1ブランチ1スタック」制約は回避でき、名前の上では輪が閉じる。

```
main ← cyc-a ← cyc-b ← cyc-c ← cyc-a-dash(≒cyc-a)
```

しかし `gh stack rebase` すると git が重複コミットを自動的に落とし、一直線になる。
`cyc-a` は `cyc-a-dash` の祖先だが逆は成立しない。git の DAG が循環できない以上、
輪に見えるのは名前だけで実体は伸びた直線。なお trunk になった `cyc-c` は
`belongs to multiple stacks` で操作不能になる。

### まとめ

循環を防いでいるのは循環検出ではなく、
(1) git の DAG、(2) 順序付き配列のデータモデル、(3) 1ブランチ1スタック制約 の3つ。
(3) は別名で迂回できるが、迂回しても (1)(2) に潰されて直線に戻る。

問題は**その過程が全て無警告**で、しかも PR が勝手に MERGED になること。

## 未検証の事項

- スタックの層に付いたレビューコメントが force push 後に残るか / Outdated になるか
- `.git/gh-stack` を素の `git rebase` で不整合にした状態で `gh stack` を実行した場合の挙動
- `gh stack checkout` で GitHub 側のスタックからローカル追跡を復元する動作
- merge queue とスタックの組み合わせ（ロールアウト進行中）
- Web UI の "Rebase stack" ボタン（ドキュメント上は unsigned commit を生成するとされる）
- コンフリクトが層ごとに繰り返し発生するか（1層で解決すれば上の層でも解決されるか）
- `/repos/{owner}/{repo}/stacks` への POST でスタックを直接作れるか（拡張なしでの操作）
