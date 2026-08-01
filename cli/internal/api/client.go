package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 32 * 1024 * 1024

type Client struct {
	baseURL          *url.URL
	sessionCookie    string
	builtinSignedOut bool
	httpClient       *http.Client
	userAgent        string
}

type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

type Error struct {
	StatusCode int             `json:"statusCode"`
	Code       string          `json:"code"`
	Message    string          `json:"message"`
	RequestID  string          `json:"requestId,omitempty"`
	Details    json.RawMessage `json:"details,omitempty"`
}

func (e *Error) Error() string {
	if e.Code == "" {
		if e.Message != "" {
			return fmt.Sprintf("Sandpi API returned HTTP %d: %s", e.StatusCode, e.Message)
		}
		return fmt.Sprintf("Sandpi API returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func New(endpoint, sessionCookie string, builtinSignedOut bool, userAgent string, httpClient *http.Client) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, fmt.Errorf("invalid Sandpi endpoint %q", endpoint)
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, fmt.Errorf("Sandpi endpoint must use HTTP or HTTPS")
	}
	if baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.User != nil {
		return nil, fmt.Errorf("Sandpi endpoint cannot contain credentials, query, or fragment")
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{
		baseURL:          baseURL,
		sessionCookie:    sessionCookie,
		builtinSignedOut: builtinSignedOut,
		httpClient:       httpClient,
		userAgent:        userAgent,
	}, nil
}

func (c *Client) Endpoint() string {
	return c.baseURL.String()
}

func (c *Client) Do(ctx context.Context, method, requestPath string, body any) (*Response, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	requestURL, err := c.resolve(requestPath)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, reader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.userAgent != "" {
		request.Header.Set("User-Agent", c.userAgent)
	}
	if c.sessionCookie != "" {
		request.AddCookie(&http.Cookie{Name: "sandpi_session", Value: c.sessionCookie})
	} else if c.builtinSignedOut {
		request.AddCookie(&http.Cookie{Name: "sandpi_signed_out", Value: "1"})
	}
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodDelete {
		request.Header.Set("Origin", c.baseURL.Scheme+"://"+c.baseURL.Host)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request Sandpi API: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Sandpi response: %w", err)
	}
	if len(responseBody) > maxResponseBytes {
		return nil, errors.New("Sandpi response exceeds 32 MiB")
	}
	result := &Response{
		StatusCode: response.StatusCode,
		Header:     response.Header.Clone(),
		Body:       responseBody,
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, decodeError(response.StatusCode, responseBody)
	}
	return result, nil
}

func (c *Client) Data(ctx context.Context, method, requestPath string, body any) (json.RawMessage, error) {
	response, err := c.Do(ctx, method, requestPath, body)
	if err != nil {
		return nil, err
	}
	if len(response.Body) == 0 {
		return json.RawMessage("null"), nil
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.Body, &envelope); err != nil || envelope.Data == nil {
		return nil, errors.New("Sandpi API returned an invalid data envelope")
	}
	return envelope.Data, nil
}

func (c *Client) resolve(requestPath string) (string, error) {
	if !strings.HasPrefix(requestPath, "/") {
		return "", errors.New("Sandpi API path must start with /")
	}
	requestURL, err := url.Parse(c.baseURL.Path + requestPath)
	if err != nil {
		return "", fmt.Errorf("invalid Sandpi API path: %w", err)
	}
	requestURL.Scheme = c.baseURL.Scheme
	requestURL.Host = c.baseURL.Host
	return requestURL.String(), nil
}

func decodeError(statusCode int, body []byte) error {
	var envelope struct {
		Error struct {
			Code      string          `json:"code"`
			Message   string          `json:"message"`
			RequestID string          `json:"requestId"`
			Details   json.RawMessage `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) != nil || envelope.Error.Code == "" {
		return &Error{StatusCode: statusCode, Message: strings.TrimSpace(string(body))}
	}
	return &Error{
		StatusCode: statusCode,
		Code:       envelope.Error.Code,
		Message:    envelope.Error.Message,
		RequestID:  envelope.Error.RequestID,
		Details:    envelope.Error.Details,
	}
}
