package erd.core.fixtures;

import com.fasterxml.jackson.core.PrettyPrinter;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.core.util.Separators;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

/**
 * model.json（Java / TS 間の交換表現）の決定論的な整形。
 * 2スペース・LF・"key": value 形式。
 */
public final class Json {
    private Json() {}

    public static final ObjectMapper MAPPER = JsonMapper.builder().build();

    public static String pretty(Object value) {
        try {
            DefaultPrettyPrinter pp = new DefaultPrettyPrinter()
                    .withSeparators(Separators.createDefaultInstance()
                            .withObjectFieldValueSpacing(Separators.Spacing.AFTER));
            DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
            pp.indentObjectsWith(indenter);
            pp.indentArraysWith(indenter);
            PrettyPrinter printer = pp;
            return MAPPER.writer(printer).writeValueAsString(value) + "\n";
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
