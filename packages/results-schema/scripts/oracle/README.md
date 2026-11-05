# ParserProbe: run the server's parser over fixture files

`ParserProbe.java` prints one JSON line per file with the verdict of the backend's `ToResultsJsonParser`
(accepted + result count, or the refusal's JSON pointer and message). It produced
`test/fixtures/oracle.json`.

```bash
# in a checkout of testorchestrator-backend at the commit you want to compare against
mvn -q package -DskipTests
javac -cp target/classes -d /tmp/probe ParserProbe.java
java -Dloader.main=ParserProbe -Dloader.path=/tmp/probe \
  -cp target/testorchestrator-backend-1.0.0.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher \
  test/fixtures/parser/*.json test/fixtures/corpus/*.json > verdicts.jsonl
```

Wrap the lines as `{ "generatedBy": "<parser, commit>", "verdicts": [ ...lines ] }` into
`test/fixtures/oracle.json`.
