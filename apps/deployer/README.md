# deployer

設置タグの配信ファイル(bootstrap と runtime)を、配信専用の Worker(`wtt-static`)の静的アセットとしてデプロイする Worker です。管理用の Worker(control)からの依頼でだけ動き(Service Binding の RPC)、インターネットからは届きません。HTTP の要求にはどれも 404 を返します。依頼は Durable Object が 1 本ずつ流し、失敗したデプロイは間隔をあけて再試行します。毎時の Cron で、runtime の更新と取り残しを確かめます。

この Worker が持つものは、Workers Scripts の Edit だけを持つ API トークン(secret `CF_DEPLOY_TOKEN`)と、var `CF_ACCOUNT_ID`(配信専用の Worker があるアカウント)・`STATIC_SCRIPT_NAME`(配信専用の Worker の名前。既定 `wtt-static`)です。トークンはアカウント内のすべての Worker を書き換えられるので、この Worker にだけ置きます。名前が `wtt-static` で始まる規則に合わない `STATIC_SCRIPT_NAME` は、別の Worker を上書きしないよう拒否します。

配信専用の Worker(`wtt-static`)には `wrangler deploy` を使わないでください。手元のファイルで、全 Site の配信ファイルが置き換わって消えます。作り方と更新は `docs/deploy.md` を見てください。
