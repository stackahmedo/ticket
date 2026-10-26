package main

import (
	"reflect"
	"testing"
)

func TestUniqueSortedIDs(t *testing.T) {
	ids, err := uniqueSortedIDs([]string{
		"40000000-0000-4000-8000-000000000002",
		"40000000-0000-4000-8000-000000000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"}
	if !reflect.DeepEqual(ids, expected) {
		t.Fatalf("expected %v, got %v", expected, ids)
	}
}
func TestUniqueSortedIDsRejectDuplicates(t *testing.T) {
	_, err := uniqueSortedIDs([]string{"40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000001"})
	if err == nil {
		t.Fatal("expected duplicate rejection")
	}
}
func TestUniqueSortedIDsRejectLargeGroup(t *testing.T) {
	_, err := uniqueSortedIDs(make([]string, 7))
	if err == nil {
		t.Fatal("expected max ticket count rejection")
	}
}
