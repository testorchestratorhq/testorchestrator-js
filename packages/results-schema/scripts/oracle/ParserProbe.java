import com.testorchestrator.modules.automation.ingest.parse.*;
import java.io.*;
import java.nio.file.*;

/** TES-1022: runs the shipped ToResultsJsonParser over files; one JSON line per file. */
public class ParserProbe {
    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            char bs = (char) 92;
            if (c == '"' || c == bs) { b.append(bs).append(c); }
            else if (c < 0x20) { b.append(bs).append('u').append(String.format("%04x", (int) c)); }
            else { b.append(c); }
        }
        return b.append('"').toString();
    }
    public static void main(String[] args) throws Exception {
        ToResultsJsonParser parser = new ToResultsJsonParser();
        for (String f : args) {
            Path p = Paths.get(f);
            String name = p.getFileName().toString();
            try (InputStream in = Files.newInputStream(p)) {
                ParsedResults r = parser.parse(in, ParseLimits.DEFAULT);
                System.out.println("{\"file\":" + q(name) + ",\"accepted\":true,\"results\":" + r.results().size()
                        + ",\"warnings\":" + r.warnings().size() + "}");
            } catch (ResultsParseException e) {
                System.out.println("{\"file\":" + q(name) + ",\"accepted\":false,\"location\":" + q(e.location())
                        + ",\"message\":" + q(e.getMessage()) + "}");
            } catch (TooManyResultsException e) {
                System.out.println("{\"file\":" + q(name) + ",\"accepted\":false,\"location\":\"/results\",\"message\":" + q(e.getMessage()) + ",\"tooMany\":true}");
            } catch (RuntimeException e) {
                System.out.println("{\"file\":" + q(name) + ",\"accepted\":false,\"crash\":" + q(e.getClass().getName() + ": " + e.getMessage()) + "}");
            }
        }
    }
}
