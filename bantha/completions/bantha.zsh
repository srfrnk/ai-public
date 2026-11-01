#compdef bantha agents

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

    _arguments -C \
        '1: :->command' \
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

