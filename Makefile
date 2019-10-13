include config.mk

PROJECTNAME = the-bot-has-eyes
HOMEDIR = $(shell pwd)
APPDIR = /opt/$(PROJECTNAME)

pushall: sync
	git push origin master

sync:
	rsync -a $(HOMEDIR) $(USER)@$(SERVER):/opt/ --exclude node_modules/ --exclude data/
	$(SSHCMD) "cd $(APPDIR) && npm install"

prettier:
	prettier --single-quote --write "**/*.js"

# This doesn't quite work. Hit Ctrl-C when you've had enough. Or fix this.
run-multiple:
	number=1 ; while [ $$number -le 10 ] ; do \
		node eyes-post.js --dry; \
		((number = number + 1)) ; \
	done

