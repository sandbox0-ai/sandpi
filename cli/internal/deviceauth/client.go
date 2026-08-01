package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxResponseBytes = 1024 * 1024
	defaultInterval  = 5 * time.Second
)

type Client struct {
	issuer     *url.URL
	clientID   string
	scope      string
	httpClient *http.Client
	wait       func(context.Context, time.Duration) error
}

type Flow struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
	tokenEndpoint           string
}

type providerMetadata struct {
	Issuer                      string `json:"issuer"`
	DeviceAuthorizationEndpoint string `json:"device_authorization_endpoint"`
	TokenEndpoint               string `json:"token_endpoint"`
}

type Tokens struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
}

type oauthError struct {
	Code        string `json:"error"`
	Description string `json:"error_description"`
}

func New(issuer, clientID, scope string, httpClient *http.Client) (*Client, error) {
	parsedIssuer, err := parseEndpoint(issuer)
	if err != nil {
		return nil, fmt.Errorf("invalid device authorization issuer: %w", err)
	}
	if strings.TrimSpace(clientID) == "" {
		return nil, errors.New("device authorization client id is required")
	}
	if strings.TrimSpace(scope) == "" {
		return nil, errors.New("device authorization scope is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{
		issuer:     parsedIssuer,
		clientID:   strings.TrimSpace(clientID),
		scope:      strings.TrimSpace(scope),
		httpClient: httpClient,
		wait:       wait,
	}, nil
}

// Start discovers the provider and creates one short-lived device login.
func (c *Client) Start(ctx context.Context) (*Flow, error) {
	metadata, err := c.discover(ctx)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"client_id": {c.clientID},
		"scope":     {c.scope},
	}
	var flow Flow
	if err := c.postForm(ctx, metadata.DeviceAuthorizationEndpoint, form, &flow); err != nil {
		return nil, fmt.Errorf("start device authorization: %w", err)
	}
	if flow.DeviceCode == "" || flow.UserCode == "" || flow.VerificationURI == "" || flow.ExpiresIn <= 0 {
		return nil, errors.New("identity provider returned an incomplete device authorization response")
	}
	if _, err := parseEndpoint(flow.VerificationURI); err != nil {
		return nil, fmt.Errorf("invalid device verification URL: %w", err)
	}
	if flow.VerificationURIComplete != "" {
		if _, err := parseVerificationURL(flow.VerificationURIComplete); err != nil {
			return nil, fmt.Errorf("invalid complete device verification URL: %w", err)
		}
	}
	flow.tokenEndpoint = metadata.TokenEndpoint
	return &flow, nil
}

func (c *Client) Poll(ctx context.Context, flow *Flow) (*Tokens, error) {
	if flow == nil || flow.DeviceCode == "" || flow.tokenEndpoint == "" || flow.ExpiresIn <= 0 {
		return nil, errors.New("device authorization flow is incomplete")
	}
	interval := time.Duration(flow.Interval) * time.Second
	if interval <= 0 {
		interval = defaultInterval
	}
	deadline := time.Now().Add(time.Duration(flow.ExpiresIn) * time.Second)
	for {
		if time.Now().Add(interval).After(deadline) {
			return nil, errors.New("device authorization expired")
		}
		if err := c.wait(ctx, interval); err != nil {
			return nil, err
		}
		form := url.Values{
			"client_id":   {c.clientID},
			"device_code": {flow.DeviceCode},
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		}
		var token Tokens
		oauthFailure, err := c.postToken(ctx, flow.tokenEndpoint, form, &token)
		if err != nil {
			return nil, fmt.Errorf("poll device authorization: %w", err)
		}
		if oauthFailure == nil {
			if token.AccessToken == "" || token.IDToken == "" {
				return nil, errors.New("identity provider returned incomplete OIDC tokens")
			}
			return &token, nil
		}
		switch oauthFailure.Code {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "access_denied":
			return nil, errors.New("device authorization was denied")
		case "expired_token":
			return nil, errors.New("device authorization expired")
		default:
			message := oauthFailure.Description
			if message == "" {
				message = oauthFailure.Code
			}
			return nil, fmt.Errorf("identity provider rejected device authorization: %s", message)
		}
	}
}

func (flow *Flow) VerificationURL() string {
	if flow.VerificationURIComplete != "" {
		return flow.VerificationURIComplete
	}
	return flow.VerificationURI
}

func (c *Client) discover(ctx context.Context) (*providerMetadata, error) {
	discovery := *c.issuer
	discovery.Path = strings.TrimRight(discovery.Path, "/") + "/.well-known/openid-configuration"
	var metadata providerMetadata
	if err := c.getJSON(ctx, discovery.String(), &metadata); err != nil {
		return nil, fmt.Errorf("discover identity provider: %w", err)
	}
	if normalizeIssuer(metadata.Issuer) != normalizeIssuer(c.issuer.String()) {
		return nil, errors.New("identity provider discovery issuer does not match Sandpi configuration")
	}
	for name, value := range map[string]string{
		"device authorization endpoint": metadata.DeviceAuthorizationEndpoint,
		"token endpoint":                metadata.TokenEndpoint,
	} {
		if _, err := parseEndpoint(value); err != nil {
			return nil, fmt.Errorf("invalid %s: %w", name, err)
		}
	}
	return &metadata, nil
}

func (c *Client) getJSON(ctx context.Context, target string, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("identity provider returned HTTP %d", response.StatusCode)
	}
	return decodeJSON(response.Body, output)
}

func (c *Client) postForm(ctx context.Context, target string, form url.Values, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure oauthError
		if decodeJSON(response.Body, &failure) == nil && failure.Code != "" {
			return fmt.Errorf("%s: %s", failure.Code, failure.Description)
		}
		return fmt.Errorf("identity provider returned HTTP %d", response.StatusCode)
	}
	return decodeJSON(response.Body, output)
}

func (c *Client) postToken(ctx context.Context, target string, form url.Values, token *Tokens) (*oauthError, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil, decodeJSON(response.Body, token)
	}
	var failure oauthError
	if err := decodeJSON(response.Body, &failure); err != nil || failure.Code == "" {
		return nil, fmt.Errorf("identity provider returned HTTP %d", response.StatusCode)
	}
	return &failure, nil
}

func decodeJSON(reader io.Reader, output any) error {
	content, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(content) > maxResponseBytes {
		return errors.New("identity provider response exceeds 1 MiB")
	}
	if err := json.Unmarshal(content, output); err != nil {
		return errors.New("identity provider returned invalid JSON")
	}
	return nil
}

func parseEndpoint(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" {
		return nil, errors.New("URL must be absolute")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname())) {
		return nil, errors.New("URL must use HTTPS except on loopback")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("URL cannot contain credentials, query, or fragment")
	}
	return parsed, nil
}

func parseVerificationURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" {
		return nil, errors.New("URL must be absolute")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname())) {
		return nil, errors.New("URL must use HTTPS except on loopback")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("URL cannot contain credentials or fragment")
	}
	return parsed, nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func normalizeIssuer(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
