package service

import (
	"encoding/json"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

type ContentAuditSegment struct {
	Source  string `json:"source"`
	Ordinal int    `json:"ordinal"`
	Current bool   `json:"current"`
	Text    string `json:"text"`
}
type ContentAuditInput struct {
	Segments         []ContentAuditSegment
	CoverageComplete bool
}

// BuildContentAuditInput retains caller-controlled roles as data and keeps
// media payloads out of text audit. No URLs are fetched here.
func BuildContentAuditInput(request dto.Request, fallback string) ContentAuditInput {
	var fields map[string]json.RawMessage
	if request != nil {
		if encoded, err := common.Marshal(request); err == nil {
			_ = common.Unmarshal(encoded, &fields)
		}
	}
	var segments []ContentAuditSegment
	for _, key := range []string{"instructions", "instruction", "system", "systemInstruction"} {
		if text := auditText(fields[key]); text != "" {
			segments = append(segments, ContentAuditSegment{Source: key, Text: text})
		}
	}
	for _, key := range []string{"messages", "input", "contents"} {
		raw := fields[key]
		if len(raw) == 0 {
			continue
		}
		var items []json.RawMessage
		if common.Unmarshal(raw, &items) != nil {
			if text := auditText(raw); text != "" {
				segments = append(segments, ContentAuditSegment{Source: "user", Text: text})
			}
			continue
		}
		for index, item := range items {
			var message struct {
				Role string `json:"role"`
				Type string `json:"type"`
			}
			_ = common.Unmarshal(item, &message)
			role := message.Role
			if role == "" {
				role = message.Type
			}
			if role == "" {
				role = "user"
			}
			if role == "function_call_output" || role == "tool_result" {
				role = "tool"
			}
			if role == "model" {
				role = "assistant"
			}
			if text := auditText(item); text != "" {
				segments = append(segments, ContentAuditSegment{Source: role, Ordinal: index, Text: text})
			}
		}
	}
	if tools := fields["tools"]; len(tools) > 0 && string(tools) != "null" {
		segments = append(segments, ContentAuditSegment{Source: "client_tools", Text: string(tools)})
	}
	if len(segments) == 0 {
		if text := auditText(fields["prompt"]); text != "" {
			fallback = text
		}
		if fallback != "" {
			segments = append(segments, ContentAuditSegment{Source: "normalized_request", Text: fallback})
		}
	}
	// Latest user and tool segments precede instructions and older history.
	prioritized := make([]ContentAuditSegment, 0, len(segments))
	for _, source := range []string{"user", "tool"} {
		latest := true
		for i := len(segments) - 1; i >= 0; i-- {
			if segments[i].Source == source {
				segments[i].Current = latest
				latest = false
				if segments[i].Current {
					prioritized = append(prioritized, segments[i])
				}
			}
		}
	}
	for _, segment := range segments {
		if segment.Source != "user" && segment.Source != "tool" && segment.Source != "assistant" {
			prioritized = append(prioritized, segment)
		}
	}
	for i := len(segments) - 1; i >= 0; i-- {
		if !segments[i].Current && (segments[i].Source == "user" || segments[i].Source == "tool" || segments[i].Source == "assistant") {
			prioritized = append(prioritized, segments[i])
		}
	}
	return ContentAuditInput{Segments: prioritized, CoverageComplete: true}
}

func auditText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if common.Unmarshal(raw, &text) == nil {
		return text
	}
	var items []json.RawMessage
	if common.Unmarshal(raw, &items) == nil {
		parts := make([]string, 0, len(items))
		for _, item := range items {
			if text := auditText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	}
	var fields map[string]json.RawMessage
	if common.Unmarshal(raw, &fields) != nil {
		return ""
	}
	var kind string
	_ = common.Unmarshal(fields["type"], &kind)
	switch kind {
	case "image", "image_url", "input_image", "input_audio", "audio", "file", "input_file", "video", "reasoning":
		return ""
	}
	var parts []string
	for _, key := range []string{"text", "content", "parts", "output", "input", "arguments", "tool_calls", "function", "functionCall", "functionResponse", "response", "result"} {
		if value := fields[key]; len(value) > 0 {
			text := auditText(value)
			if text == "" && (key == "arguments" || key == "response" || key == "result") {
				text = string(value)
			}
			if text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// auditSegments preserves full coverage for callers of the legacy text API.
func auditSegments(input string) []string {
	const width = 3000
	const overlap = 160
	runes := []rune(input)
	if len(runes) == 0 {
		return nil
	}
	var chunks []string
	for start := 0; start < len(runes); {
		end := min(start+width, len(runes))
		chunks = append(chunks, string(runes[start:end]))
		if end == len(runes) {
			break
		}
		start = end - overlap
	}
	return chunks
}

func auditInputChunks(input ContentAuditInput) ([]ContentAuditSegment, bool) {
	const limit = 16
	chunks := make([]ContentAuditSegment, 0, limit)
	complete := input.CoverageComplete
	for _, part := range input.Segments {
		runes := []rune(part.Text)
		// Start at the end of each recent message, then work backwards with overlap.
		for end := len(runes); end > 0; {
			if len(chunks) == limit {
				return chunks, false
			}
			start := max(0, end-3000)
			chunks = append(chunks, ContentAuditSegment{Source: part.Source, Ordinal: part.Ordinal, Current: part.Current, Text: string(runes[start:end])})
			if start == 0 {
				break
			}
			end = start + 160
		}
	}
	return chunks, complete
}
