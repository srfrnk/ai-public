export class CompletionGenerator {
  public static getBashCompletion(): string {
    return `#!/usr/bin/env bash
# Bash completion for bantha runner

_bantha_completions() {
    local cur prev words cword
    if type _init_completion >/dev/null 2>&1; then
        _init_completion -n = || return
    else
        cur="\${COMP_WORDS[COMP_CWORD]}"
        prev="\${COMP_WORDS[COMP_CWORD-1]}"
        words=("\${COMP_WORDS[@]}")
        cword=\$COMP_CWORD
    fi

    local commands="pi goose crush hermes tuskens build status completion help"

    if [ "$cword" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return 0
    fi

    case "\${words[1]}" in
        completion)
            if [ "$cword" -eq 2 ]; then
                COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
            fi
            ;;
        build)
            if [ "$cword" -eq 2 ]; then
                COMPREPLY=( $(compgen -W "--force" -- "$cur") )
            fi
            ;;
        *)
            ;;
    esac
}

complete -F _bantha_completions bantha
complete -F _bantha_completions agents 2>/dev/null || true
`;
  }

  public static getZshCompletion(): string {
    return `#compdef bantha agents

_bantha() {
    local -a commands
    commands=(
        'pi:Launch Pi coding assistant (tusken)'
        'goose:Launch Goose developer agent (tusken)'
        'crush:Launch Crush CLI agent (tusken)'
        'hermes:Launch Hermes autonomous agent (tusken)'
        'tuskens:List available tuskens (agents)'
        'build:Build or rebuild bantha container image'
        'status:Display current sandbox config and isolation status'
        'completion:Output shell completion script'
        'help:Display help information'
    )

    _arguments -C \\
        '1: :->command' \\
        '*:: :->args'

    case $state in
        command)
            _describe -t commands 'bantha commands' commands
            ;;
        args)
            case $words[1] in
                completion)
                    _values 'shells' 'bash' 'zsh' 'fish'
                    ;;
                build)
                    _values 'flags' '--force'
                    ;;
            esac
            ;;
    esac
}

compdef _bantha bantha 2>/dev/null || true
compdef _bantha agents 2>/dev/null || true
`;
  }

  public static getFishCompletion(): string {
    return `# Fish completion for bantha runner

complete -c bantha -f
complete -c agents -f

complete -c bantha -n "__fish_use_subcommand" -a "pi" -d "Launch Pi coding assistant (tusken)"
complete -c bantha -n "__fish_use_subcommand" -a "goose" -d "Launch Goose developer agent (tusken)"
complete -c bantha -n "__fish_use_subcommand" -a "crush" -d "Launch Crush CLI agent (tusken)"
complete -c bantha -n "__fish_use_subcommand" -a "hermes" -d "Launch Hermes autonomous agent (tusken)"
complete -c bantha -n "__fish_use_subcommand" -a "tuskens" -d "List available tuskens (agents)"
complete -c bantha -n "__fish_use_subcommand" -a "build" -d "Build or rebuild container image"
complete -c bantha -n "__fish_use_subcommand" -a "status" -d "Display current sandbox status"
complete -c bantha -n "__fish_use_subcommand" -a "completion" -d "Output shell completion"

complete -c bantha -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"
complete -c bantha -n "__fish_seen_subcommand_from build" -l force -d "Force rebuild image"
`;
  }
}
