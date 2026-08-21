# stacked-pr

GitHub の Stacked PR を検証するための実験用リポジトリ。

検証結果は **[FINDINGS.md](FINDINGS.md)** にまとめてある。

## リポジトリ内に残っている検証用ブランチ

| ブランチ群 | PR | 内容 |
|---|---|---|
| `step-1/2/3` | #1〜#3 | 素の git + `gh pr create --base` で作った連鎖（スタック登録なし） |
| `stack-1/2/3` | #5〜#7 | `gh stack` で作った同内容のスタック（stack #8） |
| `develop-*` + `feat-*` | #9〜#19 | develop 連鎖の各段に feature スタックを持つ階層構成 |
| `cyc-*` | #21〜#26 | 循環参照の検証 |

いずれも検証の証跡として意図的に残している。
