# Fish completion for bantha runner

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

