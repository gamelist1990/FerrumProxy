package com.ferrumproxy.geyser;

import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.nodes.*;
import java.io.StringReader;
import java.util.*;

/**
 * Edit scalar spans, preserving comments and every unrelated Geyser setting.
 */
final class ConfigPatch {
    record Edit(int start, int end, String value) {
    }

    static String https(String text, String certificate, String key) {
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(false);
        options.setMaxAliasesForCollections(20);
        Yaml yaml = new Yaml(new SafeConstructor(options));
        Object parsed = yaml.load(text);
        if (!(parsed instanceof Map<?, ?>))
            throw new IllegalArgumentException("Geyser config must be a YAML mapping");
        MappingNode root = mapping(yaml.compose(new StringReader(text)));
        List<String> path = List.of("bedrock", "signaling", "builtin", "https");
        MappingNode current = root;
        int depth = 0;
        for (; depth < path.size(); depth++) {
            Node value = get(current, path.get(depth));
            if (value == null)
                break;
            current = mapping(value);
        }
        LinkedHashMap<String, String> replacements = new LinkedHashMap<>();
        replacements.put("certificate", certificate);
        replacements.put("private-key", key);
        replacements.put("password", "");
        List<Edit> edits = new ArrayList<>();
        int indent = current.getValue().isEmpty() ? depth * 2
                : current.getValue().getFirst().getKeyNode().getStartMark().getColumn();
        String newline = text.contains("\r\n") ? "\r\n" : "\n";
        StringBuilder addition = new StringBuilder();
        if (depth < path.size()) {
            for (int index = depth; index < path.size(); index++, indent += 2)
                addition.append(" ".repeat(indent)).append(path.get(index)).append(':').append(newline);
        }
        for (var entry : replacements.entrySet()) {
            Node existing = depth == path.size() ? get(current, entry.getKey()) : null;
            String quoted = "'" + entry.getValue().replace("'", "''") + "'";
            if (existing != null) {
                if (!(existing instanceof ScalarNode))
                    throw new IllegalArgumentException("HTTPS paths must be YAML scalars");
                edits.add(new Edit(offset(text, existing.getStartMark().getIndex()),
                        offset(text, existing.getEndMark().getIndex()), quoted));
            } else
                addition.append(" ".repeat(indent)).append(entry.getKey()).append(": ").append(quoted).append(newline);
        }
        if (!addition.isEmpty()) {
            if (current.getFlowStyle() == org.yaml.snakeyaml.DumperOptions.FlowStyle.FLOW)
                throw new IllegalArgumentException("Use block YAML mappings for Geyser's HTTPS configuration");
            int at = offset(text, current.getEndMark().getIndex());
            String prefix = at > 0 && text.charAt(at - 1) != '\n' ? newline : "";
            edits.add(new Edit(at, at, prefix + addition));
        }
        edits.sort(Comparator.comparingInt(Edit::start).reversed());
        StringBuilder result = new StringBuilder(text);
        for (Edit edit : edits)
            result.replace(edit.start(), edit.end(), edit.value());
        // Validate the final structure, not only the source.
        Map<?, ?> finalRoot = yaml.load(result.toString());
        Map<?, ?> ssl = finalRoot;
        for (String part : path)
            ssl = (Map<?, ?>) ssl.get(part);
        for (var entry : replacements.entrySet())
            if (!entry.getValue().equals(ssl.get(entry.getKey())))
                throw new IllegalArgumentException("Cannot safely patch Geyser HTTPS settings");
        return result.toString();
    }

    private static int offset(String text, int codePoints) {
        return text.offsetByCodePoints(0, codePoints);
    }

    private static MappingNode mapping(Node node) {
        if (!(node instanceof MappingNode mapping))
            throw new IllegalArgumentException("Geyser HTTPS section must be a mapping");
        return mapping;
    }

    private static Node get(MappingNode mapping, String key) {
        for (NodeTuple tuple : mapping.getValue())
            if (tuple.getKeyNode() instanceof ScalarNode scalar && key.equals(scalar.getValue()))
                return tuple.getValueNode();
        return null;
    }
}
