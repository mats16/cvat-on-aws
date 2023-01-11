# CVAT on AWS

CVAT を AWS 上で動かすためのテンプレート

## デプロイ方法

### 環境セットアップ

Node.js や AWS CLI, Docker が必要だが、[devcontainer](./.devcontainer.json) で定義している。VScode や CodeSpaces を利用しこのコンテナを利用するのがオススメ。

### AWS のクレデンシャルの設定

Turing は AWS の [IAM Identity Center](https://aws.amazon.com/jp/iam/identity-center/) を利用しているため、SSO の設定が必要。

```bash
aws configure sso --profile default
```

2回目以降は login のみでよい。

```bash
aws sso login
```

### 依存パッケージのインストール

package.json や tsconfig.json は [projen](https://github.com/projen/projen) により自動生成されている。必要なものがある場合は [.projenrc.js](./.projenrc.js) を編集し、`npx projen` を実行する。

リポジトリのクローン直後など `projen`　が無いと怒られ場合は `yarn install` で入れる。

### デプロイ

`build` は必須ではないが、環境のスナップショットファイルが生成されるので、Git リポジトリに上げる前には実行しておくと良い。生成される CloudFormation テンプレートの変更点がわかる。

```bash
npx projen build
npx projen deploy
```

#### CDK Bootstrap

デプロイ先の AWS アカウント/リージョン で初めて CDK を使う場合は Bootstrap が必要。Bootstrap コマンドを実行することで必要な S3 Bucket や IAM Role が作成される。

```bash
npx cdk bootstrap aws://123456789012/us-west-2
```

## Superuser の作成

Django のカスタムコマンド `python3 ~/manage.py createsuperuser` で作成する必要がある。

ECS では [ECS Exec](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/userguide/ecs-exec.html) を利用することでコンテナ内でコマンドを実行する小tができるのでこれを利用する。実行には **cluster-name** と **task-id** が必要なため、[ECS コンソール](https://us-west-2.console.aws.amazon.com/ecs/v2/clusters?region=us-west-2) を開き、**cluster-name** と `CVAT-UtilsService` の **task-id** を確認する。

また Session Manager plugin のインストールが必要なため、[ドキュメント](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html#install-plugin-debian)を参考に入れておく。

```bash
aws ecs execute-command --cluster cluster-name \
    --task task-id \
    --container app \
    --interactive \
    --command "python3 ./manage.py createsuperuser"
```

## Oauth の設定

CloudFormation のパラメーターから設定できるようになっているので [コンソール](https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks) からお願いします。
