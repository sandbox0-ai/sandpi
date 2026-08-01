package command

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

type skillFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Executable    bool   `json:"executable"`
}

func (a *App) skillCommand() *cobra.Command {
	command := &cobra.Command{Use: "skill", Short: "Manage Environment Codex skills"}
	command.AddCommand(
		a.skillListCommand(),
		a.skillPutCommand(),
		a.skillDeleteCommand(),
		a.skillEnabledCommand(true),
		a.skillEnabledCommand(false),
	)
	return command
}

func (a *App) skillListCommand() *cobra.Command {
	var environmentID string
	var force bool
	command := &cobra.Command{
		Use:   "list",
		Short: "List discovered skills",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			path := environmentPath(environmentID) + "/harnesses/codex/skills"
			if force {
				path += "?force=1"
			}
			return a.data(command.Context(), http.MethodGet, path, nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&force, "force", false, "force native skill discovery refresh")
	return command
}

func (a *App) skillPutCommand() *cobra.Command {
	var environmentID string
	var disabled bool
	command := &cobra.Command{
		Use:   "put <name> <directory>",
		Short: "Create or replace one user-owned skill directory",
		Args:  cobra.ExactArgs(2),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			files, err := collectSkillFiles(args[1])
			if err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodPut, skillPath(environmentID, args[0]), map[string]any{
				"files":   files,
				"enabled": !disabled,
			})
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&disabled, "disabled", false, "install the skill disabled")
	return command
}

func (a *App) skillDeleteCommand() *cobra.Command {
	var environmentID string
	var yes bool
	command := &cobra.Command{
		Use:   "delete <name>",
		Short: "Delete one user-owned skill",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			if err := requireYes(yes); err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodDelete, skillPath(environmentID, args[0]), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&yes, "yes", false, "confirm deletion")
	return command
}

func (a *App) skillEnabledCommand(enabled bool) *cobra.Command {
	var environmentID string
	verb := "enable"
	if !enabled {
		verb = "disable"
	}
	command := &cobra.Command{
		Use:   verb + " <name-or-path>",
		Short: strings.ToUpper(verb[:1]) + verb[1:] + " one discovered skill",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			path := args[0]
			if !strings.HasPrefix(path, "/") {
				resolved, err := a.resolveSkillPath(command, environmentID, path)
				if err != nil {
					return err
				}
				path = resolved
			}
			return a.data(command.Context(), http.MethodPut, environmentPath(environmentID)+"/harnesses/codex/skills/config", map[string]any{
				"path":    path,
				"enabled": enabled,
			})
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) resolveSkillPath(command *cobra.Command, environmentID, name string) (string, error) {
	client, err := a.apiClient()
	if err != nil {
		return "", err
	}
	data, err := client.Data(command.Context(), http.MethodGet, environmentPath(environmentID)+"/harnesses/codex/skills?force=1", nil)
	if err != nil {
		return "", err
	}
	var inventory struct {
		Skills []struct {
			Name string `json:"name"`
			Path string `json:"path"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		return "", fmt.Errorf("decode skill inventory: %w", err)
	}
	matches := make([]string, 0, 1)
	for _, skill := range inventory.Skills {
		if skill.Name == name {
			matches = append(matches, skill.Path)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("skill %q was not found", name)
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("skill name %q is ambiguous; pass its absolute path", name)
	}
	return matches[0], nil
}

func collectSkillFiles(root string) ([]skillFile, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve skill directory: %w", err)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("read skill directory: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("skill source cannot be a symlink")
	}
	if !rootInfo.IsDir() {
		return nil, errors.New("skill source must be a directory")
	}
	files := make([]skillFile, 0)
	var totalBytes int64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != root && entry.Name() == ".git" && entry.IsDir() {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("skill cannot contain symlink %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("skill can contain only regular files: %s", path)
		}
		if len(files) >= 256 {
			return errors.New("skill can contain at most 256 files")
		}
		if info.Size() > 5*1024*1024 {
			return fmt.Errorf("skill file %s exceeds 5 MiB", path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if len(content) > 5*1024*1024 {
			return fmt.Errorf("skill file %s exceeds 5 MiB", path)
		}
		totalBytes += int64(len(content))
		if totalBytes > 10*1024*1024 {
			return errors.New("skill can contain at most 10 MiB of files")
		}
		relativePath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, skillFile{
			Path:          filepath.ToSlash(relativePath),
			ContentBase64: base64.StdEncoding.EncodeToString(content),
			Executable:    info.Mode().Perm()&0o111 != 0,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("collect skill files: %w", err)
	}
	foundManifest := false
	for _, file := range files {
		if file.Path == "SKILL.md" {
			foundManifest = true
			break
		}
	}
	if !foundManifest {
		return nil, errors.New("skill directory must contain SKILL.md")
	}
	return files, nil
}

func skillPath(environmentID, name string) string {
	return environmentPath(environmentID) + "/harnesses/codex/skills/" + url.PathEscape(name)
}
