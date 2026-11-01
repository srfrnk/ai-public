#!/usr/bin/env bash
# Bash completion for bantha runner

_bantha_completions() {
    local cur prev words cword
    if type _init_completion >/dev/null 2>&1; then
        _init_completion -n = || return
    else
        cur="${COMP_WORDS[COMP_CWORD]}"
        prev="${COMP_WORDS[COMP_CWORD-1]}"
        words=("${COMP_WORDS[@]}")
        cword=$COMP_CWORD
    fi

    local commands="pi goose crush hermes tuskens build status completion help"

    if [ "$cword" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return 0
    fi

    case "${words[1]}" in
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

