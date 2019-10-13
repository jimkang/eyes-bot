#!/bin/bash

i=0
while [ $i -lt 10 ]
do
	node eyes-post.js --dry
	((i++))
done

